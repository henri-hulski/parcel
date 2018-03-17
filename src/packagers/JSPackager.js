const fs = require('fs');
const path = require('path');
const Packager = require('./Packager');
const urlJoin = require('../utils/urlJoin');
const lineCounter = require('../utils/lineCounter');

const prelude = {
  source: fs
    .readFileSync(path.join(__dirname, '../builtins/prelude.js'), 'utf8')
    .trim(),
  minified: fs
    .readFileSync(path.join(__dirname, '../builtins/prelude.min.js'), 'utf8')
    .trim()
    .replace(/;$/, '')
};

const dedupKey = asset => {
  // cannot rely only on generated JS for deduplication as paths like `../` can
  // cause 2 identical JS files to be different depending on filesystem locations
  return {
    generatedJs: asset.generated.js,
    dependencyPaths: Array.from(asset.dependencies.keys()).map(dep => {
      if (dep.startsWith('.')) {
        return path.join(asset.name, dep);
      }
      return dep;
    })
  };
};

class JSPackager extends Packager {
  async start() {
    this.first = true;
    this.dedupe = new Map();
    this.bundleLoaders = new Set();
    this.externalModules = new Set();

    let preludeCode = this.options.minify ? prelude.minified : prelude.source;
    if (this.options.target === 'electron') {
      preludeCode =
        `process.env.HMR_PORT=${
          this.options.hmrPort
        };process.env.HMR_HOSTNAME=${JSON.stringify(
          this.options.hmrHostname
        )};` + preludeCode;
    }
    await this.dest.write(preludeCode + '({');
    this.lineOffset = lineCounter(preludeCode);
  }

  async addAsset(asset) {
    if (this.dedupe.has(dedupKey(asset))) {
      return;
    }

    // Don't dedupe when HMR is turned on since it messes with the asset ids
    if (!this.options.hmr) {
      this.dedupe.set(dedupKey(asset), asset.id);
    }

    let deps = {};
    for (let [dep, mod] of asset.depAssets) {
      // For dynamic dependencies, list the child bundles to load along with the module id
      if (dep.dynamic && this.bundle.childBundles.has(mod.parentBundle)) {
        let bundles = [this.getBundleSpecifier(mod.parentBundle)];
        for (let child of mod.parentBundle.siblingBundles) {
          if (!child.isEmpty) {
            bundles.push(this.getBundleSpecifier(child));
            this.bundleLoaders.add(child.type);
          }
        }

        bundles.push(mod.id);
        deps[dep.name] = bundles;
        this.bundleLoaders.add(mod.type);
      } else {
        deps[dep.name] = this.dedupe.get(dedupKey(mod)) || mod.id;

        // If the dep isn't in this bundle, add it to the list of external modules to preload.
        // Only do this if this is the root JS bundle, otherwise they will have already been
        // loaded in parallel with this bundle as part of a dynamic import.
        if (
          !this.bundle.assets.has(mod) &&
          (!this.bundle.parentBundle || this.bundle.parentBundle.type !== 'js')
        ) {
          this.externalModules.add(mod);
          this.bundleLoaders.add(mod.type);
        }
      }
    }

    this.bundle.addOffset(asset, this.lineOffset);
    await this.writeModule(
      asset.id,
      asset.generated.js,
      deps,
      asset.generated.map
    );
  }

  getBundleSpecifier(bundle) {
    let name = path.basename(bundle.name);
    if (bundle.entryAsset) {
      return [name, bundle.entryAsset.id];
    }

    return name;
  }

  async writeModule(id, code, deps = {}, map) {
    let wrapped = this.first ? '' : ',';
    wrapped +=
      id + ':[function(require,module,exports) {\n' + (code || '') + '\n},';
    wrapped += JSON.stringify(deps);
    wrapped += ']';

    this.first = false;
    await this.dest.write(wrapped);

    // Use the pre-computed line count from the source map if possible
    let lineCount = map && map.lineCount ? map.lineCount : lineCounter(code);
    this.lineOffset += 1 + lineCount;
  }

  async addAssetToBundle(asset) {
    if (this.bundle.assets.has(asset)) {
      return;
    }
    this.bundle.addAsset(asset);
    if (!asset.parentBundle) {
      asset.parentBundle = this.bundle;
    }

    // Add all dependencies as well
    for (let child of asset.depAssets.values()) {
      await this.addAssetToBundle(child, this.bundle);
    }

    await this.addAsset(asset);
  }

  async writeBundleLoaders() {
    if (this.bundleLoaders.size === 0) {
      return false;
    }

    let bundleLoader = this.bundler.loadedAssets.get(
      require.resolve('../builtins/bundle-loader')
    );
    if (this.externalModules.size > 0 && !bundleLoader) {
      bundleLoader = await this.bundler.getAsset('_bundle_loader');
    }

    if (bundleLoader) {
      await this.addAssetToBundle(bundleLoader);
    } else {
      return;
    }

    // Generate a module to register the bundle loaders that are needed
    let loads = 'var b=require(' + bundleLoader.id + ');';
    for (let bundleType of this.bundleLoaders) {
      let loader = this.options.bundleLoaders[bundleType];
      if (loader) {
        let asset = await this.bundler.getAsset(loader);
        await this.addAssetToBundle(asset);
        loads +=
          'b.register(' +
          JSON.stringify(bundleType) +
          ',require(' +
          asset.id +
          '));';
      }
    }

    // Preload external modules before running entry point if needed
    if (this.externalModules.size > 0) {
      let preload = [];
      for (let mod of this.externalModules) {
        preload.push([mod.generateBundleName(), mod.id]);
      }

      if (this.bundle.entryAsset) {
        preload.push(this.bundle.entryAsset.id);
      }

      loads += 'b.load(' + JSON.stringify(preload) + ');';
    }

    // Asset ids normally start at 1, so this should be safe.
    await this.writeModule(0, loads, {});
    return true;
  }

  async end() {
    let entry = [];

    // Add the HMR runtime if needed.
    if (this.options.hmr) {
      let asset = await this.bundler.getAsset(
        require.resolve('../builtins/hmr-runtime')
      );
      await this.addAssetToBundle(asset);
      entry.push(asset.id);
    }

    if (await this.writeBundleLoaders()) {
      entry.push(0);
    }

    if (this.bundle.entryAsset && this.externalModules.size === 0) {
      entry.push(this.bundle.entryAsset.id);
    }

    await this.dest.write('},{},' + JSON.stringify(entry) + ')');
    if (this.options.sourceMaps) {
      // Add source map url
      await this.dest.write(
        `\n//# sourceMappingURL=${urlJoin(
          this.options.publicURL,
          path.basename(this.bundle.name, '.js') + '.map'
        )}`
      );
    }
    await this.dest.end();
  }
}

module.exports = JSPackager;
