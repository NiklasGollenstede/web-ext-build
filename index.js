/*eslint strict: ["error", "global"], no-implicit-globals: "off"*/ 'use strict'; /* globals require, __dirname, module, process */ // license: MPL-2.0

const {
	concurrent: { _async, spawn, promisify, rejects, },
	functional: { cached, },
	network: { HttpRequest, },
} = require('es6lib');
const { join, resolve, } = require('path');

const FS = require('fs-extra');

module.exports = _async(function*(options) {
	const doLog = `doLog` in options ? options.doLog : require.main.filename === resolve(__dirname, 'bin/web-ext-build');
	const log = function() { doLog && console.log(...arguments); return arguments[arguments.length - 1]; }; // eslint-disable-line no-console
	const rootDir = options.rootDir || require('find-root')(process.cwd());
	const inRoot = (...parts) => resolve(rootDir, ...parts);
	const hasInRoot = cached(path => rejects(FS.access(inRoot(path))).then(_=>!_));

	const packageJson = Object.freeze(require(inRoot('package.json')));
	const hasIconSvg = (yield hasInRoot('icon.svg'));
	const hasIconPng = (yield hasInRoot('icon.png'));

	// files from '/' to be included
	const files = {
		'.': [
			(yield hasInRoot('background'))  && 'background/',
			(yield hasInRoot('common'))      && 'common/',
			(yield hasInRoot('content'))     && 'content/',
			(yield hasInRoot('update'))      && 'update/',
			(yield hasInRoot('views'))       && 'views/',
			'files.json',
			(!hasIconSvg || options.chrome) && hasIconPng && 'icon.png',
			hasIconSvg && 'icon.svg',
			'LICENSE',
			'manifest.json',
			'package.json',
			'README.md',
			'view.html',
		].filter(_=>_),
	};

	const defaultIcon = {
		1: hasIconSvg ? '/icon.svg' : hasIconPng ? '/icon.png' : undefined,
		64: (!hasIconSvg || options.chrome) && hasIconPng ? '/icon.png' : undefined,
	};

	const manifestJson = {
		'//': 'Generated file. Do not modify',
		manifest_version: 2,
		name: packageJson.title,
		short_name: packageJson.title,
		version: packageJson.version + (options.beta ? (options.chrome ? '.' : 'b') + options.beta : ''),
		author: packageJson.author,
		license: packageJson.license,
		description: packageJson.description,
		repository: packageJson.repository,
		contributions: packageJson.contributions,

		icons: defaultIcon,

		minimum_chrome_version: '55.0.0',
		applications: {
			gecko: {
				id: '@'+ packageJson.name,
				strict_min_version: '52.0',
			},
		},

		permissions: [
			(yield hasInRoot('common/options.js')) && 'storage',
		].filter(_=>_),
		optional_permissions: [ ],
		web_accessible_resources: Object.freeze([ ]), // must be empty
		incognito: 'spanning', // firefox only supports 'spanning'

		background: (yield hasInRoot('background/index.js')) && {
			page: 'node_modules/web-ext-utils/loader/_background.html',
			persistent: false,
		},
		options_ui: (yield hasInRoot('common/options.js')) && {
			page: 'view.html#options',
			open_in_tab: false,
		},

		content_scripts: [ ],
		browser_action: {
			default_title: packageJson.title,
			// default_popup: ((yield hasInRoot('views/panel')) || (yield hasInRoot('views/panel.js')) || (yield hasInRoot('views/panel.html'))) && 'view.html#panel' || undefined,
			default_icon: undefined, // would prevent installation in Fennec nightly 55, so set it programmatically instead
		},
		sidebar_action: ((yield hasInRoot('views/sidebar')) || (yield hasInRoot('views/sidebar.js')) || (yield hasInRoot('views/sidebar.html'))) ? {
			default_title: packageJson.title,
			default_panel: 'view.html#sidebar',
			default_icon: defaultIcon,
		} : undefined,
	};

	const configurator = require(inRoot('build-config')), arg = { options, packageJson, manifestJson, files, };
	configurator.constructor.name === 'GeneratorFunction' ? (yield spawn(configurator, null, [ arg, ])) : configurator(arg);

	const outputName = manifestJson.name.toLowerCase().replace(/[^a-z0-9\.-]+/g, '_') +'-'+ manifestJson.version;
	const outDir = options.outDir || inRoot('./build');
	const outZip = join(outDir, outputName +'.zip');

	(yield FS.writeFile(join('.', 'manifest.json'), JSON.stringify(manifestJson, null, options.beta ? null : '\t'), 'utf8'));
	(!options.outDir || options.clearOutDir) && (yield FS.remove(outDir).catch(() => log('Could not clear output dir')));
	const include = (yield listFiles(rootDir, files));

	(yield FS.writeFile(join('.', 'files.json'), JSON.stringify(include/*, null, '\t'*/), 'utf8'));
	(yield FS.copy(inRoot('node_modules/web-ext-utils/loader/_view.html'), inRoot('view.html')));
	(yield copyFiles(files, '.', join(outDir, '.')));

	// const bin = 'node '+ JSON.stringify(resolve(__dirname, 'node_modules/web-ext/bin/web-ext'));

	if ((options.zip !== false && options.zip !== 0) || options.post) {
		const exclude = outZip.slice(0, outZip.lastIndexOf('-'));
		(yield promisify(require('zip-dir'))(outDir, {
			filter: path => !(path.startsWith(exclude) && (/(?:zip|xpi)$/).test(path)),
			saveTo: outZip,
		}));
		log('Created WebExtension package', outZip);
	}
	if (options.post) {
		if (!HttpRequest.available) { throw new Error(`Can't post file, please install "xhr2"`); }
		const { host, ip, port, } = options.post, url = options.post.url ? options.post.url
		: 'http://'+ (host || ((typeof ip === 'number' ? '192.168.178.'+ ip : ip || 'localhost') +':'+ (port || 8888))) +'';
		doLog && process.stdout.write(`Posting to ${ url } ... `);
		(yield new HttpRequest({ url, method: 'post', body: (yield FS.readFile(outZip)), }).catch(({ target: xhr, }) => {
			if (xhr && (xhr.readyState === 4 || xhr.status === 399)) { return; } // for some reason 399
			log(`failed`);
			throw new Error(`Failed to post package`);
		}));
		log(`done`);
	}
	if (options.run) {
		const run = typeof options.run === 'object' ? options.run : { };

		require('babel-register')({ only: (/node_modules\/web-ext\/(?!node_modules\/)/), });
		const { default: webExtRun, } = require('web-ext/src/cmd/run');

		const firefox = typeof options.run === 'string' ? options.run : options.run.bin || ''; {
			if (firefox && (/\/|\\/).test(firefox) && (yield rejects(FS.access(firefox)))) { throw new Error(`Can't access Firefox binary at "${ firefox }"`); }
		}

		const customPrefs = {
			'javascript.options.strict': false,
		}; {
			if (run.prefs) { Object.assign(customPrefs, run.prefs); }
		}

		const app = (yield webExtRun(log('Running with options', {
			sourceDir: outDir,
			artifactsDir: outDir,
			firefox,
			firefoxProfile: null,
			keepProfileChanges: false,
			preInstall: false,
			noReload: false,
			browserConsole: true,
			customPrefs,
			startUrl: 'about:debugging',
			ignoreFiles: null,
		}), { })); void app;

		/*const prefs = options.run.prefs, prefString = !prefs ? ''
		: Object.keys(prefs).map(name => '--pref '+ name +'='+ JSON.stringify(prefs[name])).join(' ');
		log((yield run([
			bin, 'run',
			(firefox ? `--firefox-binary ${ JSON.stringify(firefox) }` : ''),
			prefString,
		].join(' '))));*/
	}

	return outputName;
});

function listFiles(rootDir, include) {
	const tree = { };

	const listFiles = _async(function*(parent, path, include) {
		const list = (yield FS.readdir(path));
		for (const entry of (path === rootDir ? list.concat([ 'files.json', ]) : list).sort()) {
			let _include = include;
			const _path = resolve(path, entry);
			const isDir = path === rootDir && entry === 'files.json' ? false : (yield FS.stat(_path)).isDirectory();
			include: if (include !== true) {
				if (!Array.isArray(_include) && _include.hasOwnProperty(entry)) { break include; }
				_include = Array.isArray(_include) ? _include : Array.isArray(_include['.']) ? _include['.'] : null;
				if (!_include) { continue; }
				if (_include.includes(entry)) { break include; }
				if (!isDir) { continue; }
				const prefix = _include.find(path => path && path.startsWith(entry +'/'));
				if (prefix == null) { continue; }
				_include = prefix.length === entry.length + 1 ? true : {
					[entry]: _include.filter(path => path && path.startsWith(entry +'/')).map(_=>_.slice(entry.length + 1)),
				};
				break include;
			}
			if (isDir) {
				const dir = parent[entry] = { };
				(yield listFiles(dir, _path, _include === true || Array.isArray(_include) ? true : _include[entry]));
			} else {
				parent[entry] = true;
			}
		}
	});

	return listFiles(tree, rootDir, include).then(() => tree);
}

function copyFiles(files, from, to) { return spawn(function*() {
	const paths = [ ];
	(function addPaths(prefix, module) {
		if (Array.isArray(module)) { return void paths.push(...module.filter(_=>_).map(file => join(prefix, file))); }
		Object.keys(module).forEach(key => module[key] && addPaths(join(prefix, key), module[key]));
	})('.', files);

	(yield Promise.all(paths.map(path =>
		FS.copy(join(from, path), join(to, path))
		.catch(error => console.warn('Skipping missing file/folder "'+ path +'"', error.code === 'ENOENT' ? '' : error))
	)));
}); }
