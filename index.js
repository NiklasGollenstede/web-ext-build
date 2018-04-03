/*eslint strict: ["error", "global"], no-implicit-globals: "off"*/ 'use strict'; /* globals require, __dirname, module, process */ // license: MPL-2.0

const {
	concurrent: { spawn, promisify, rejects, },
	functional: { cached, },
	network: { HttpRequest, },
} = require('es6lib');
const { join, resolve, } = require('path');

const FS = require('fs-extra');

module.exports = async options => {
	const doLog = `doLog` in options ? options.doLog : require.main.filename === resolve(__dirname, 'bin/web-ext-build');
	const log = function() { doLog && console.log(...arguments); return arguments[arguments.length - 1]; }; // eslint-disable-line no-console
	const rootDir = options.rootDir || require('find-root')(process.cwd());
	const inRoot = (...parts) => resolve(rootDir+'', ...parts);
	const hasInRoot = cached(path => rejects(FS.access(inRoot(path))).then(_=>!_));

	const packageJson = Object.freeze(require(inRoot('package.json')));
	const hasIconSvg = (await hasInRoot('icon.svg'));
	const hasIconPng = (await hasInRoot('icon.png'));

	class ViewPath {
		constructor(path) {
			this.path = path;
		}
		toJSON() { return this.toString(); }
	}
	Object.getOwnPropertyNames(String.prototype).forEach(method => (ViewPath.prototype[method] = String.prototype[method]));
	ViewPath.prototype.toString = ViewPath.prototype.valueOf = function() { return (options.viewRoot || 'view.html') + (this.path ? '#'+ this.path : ''); };

	// files from '/' to be included
	const files = {
		'.': [
			(await hasInRoot('background'))  && 'background/',
			(await hasInRoot('common'))      && 'common/',
			(await hasInRoot('content'))     && 'content/',
			(await hasInRoot('update'))      && 'update/',
			(await hasInRoot('views'))       && 'views/',
			'files.json',
			(!hasIconSvg || options.chrome) && hasIconPng && 'icon.png',
			hasIconSvg && 'icon.svg',
			'LICENSE',
			'manifest.json',
			'package.json',
			'README.md',
			new ViewPath(''),
		].filter(_=>_),
	};

	const defaultIcon = {
		1: hasIconSvg ? '/icon.svg' : hasIconPng ? '/icon.png' : undefined,
		64: (!hasIconSvg || options.chrome) && hasIconPng ? '/icon.png' : undefined,
	};

	const manifestJson = {
		manifest_version: 2,
		name: packageJson.title + (options.sign && options.beta ? ' - DEV' : ''),
		short_name: packageJson.title,
		version: packageJson.version + (options.beta ? (options.chrome ? '.' : 'b') + options.beta : ''),
		author: packageJson.author,
		description: packageJson.description,

		icons: defaultIcon,

		minimum_chrome_version: '55.0.0',
		applications: {
			gecko: {
				id: '@'+ packageJson.name + (options.sign && options.beta ? '-dev' : ''),
				strict_min_version: '52.0',
			},
		},

		permissions: [
			(await hasInRoot('common/options.js')) && 'storage',
		].filter(_=>_),
		optional_permissions: [ ],
		web_accessible_resources: Object.freeze([ ]), // must be empty
		incognito: 'spanning', // firefox only supports 'spanning'

		background: (await hasInRoot('background/index.js')) && {
			page: 'node_modules/web-ext-utils/loader/_background.html',
			persistent: false,
		},
		options_ui: (await hasInRoot('common/options.js')) && {
			page: new ViewPath('options'),
			open_in_tab: false,
		},

		content_scripts: [ ],
		browser_action: {
			default_title: packageJson.title,
			// default_popup: ((await hasInRoot('views/panel')) || (await hasInRoot('views/panel.js')) || (await hasInRoot('views/panel.html'))) && 'view.html#panel' || undefined,
			default_icon: undefined, // would prevent installation in Fennec nightly 55, so set it programmatically instead
		},
		sidebar_action: ((await hasInRoot('views/sidebar')) || (await hasInRoot('views/sidebar.js')) || (await hasInRoot('views/sidebar.html'))) ? {
			default_title: packageJson.title,
			default_panel: new ViewPath('sidebar'),
			default_icon: defaultIcon,
			browser_style: false,
		} : undefined,
	};

	const configurator = require(inRoot('build-config')), arg = { options, packageJson, manifestJson, files, };
	configurator.constructor.name === 'GeneratorFunction' ? (await spawn(configurator, null, [ arg, ])) : (await configurator(arg));

	let   outputName = manifestJson.name.toLowerCase().replace(/[^a-z0-9.-]+/g, '_') +'-'+ manifestJson.version;
	const outDir = options.outDir || inRoot('./build');
	let   outZip = join(outDir, outputName +'.zip');

	manifestJson.content_scripts && !manifestJson.content_scripts.length && delete manifestJson.content_scripts; // empty array causes 0x80070490 in edge
	(await FS.writeFile(join('.', 'manifest.json'), JSON.stringify(manifestJson, null, '\t'), 'utf8'));
	(!options.outDir || options.clearOutDir) && (await FS.remove(outDir).catch(() => log('Could not clear output dir')));
	const include = (await listFiles(rootDir, files));
	if (new ViewPath+'' !== 'view.html') { include['view.html'] = new ViewPath+''; include[new ViewPath+''] = true; }

	(await FS.writeFile(join('.', 'files.json'), JSON.stringify(include/*, null, '\t'*/), 'utf8'));
	(await FS.copy(inRoot('node_modules/web-ext-utils/loader/_view.html'), inRoot(new ViewPath+'')));
	(await copyFiles(files, '.', join(outDir, '.')));

	// const bin = 'node '+ JSON.stringify(resolve(__dirname, 'node_modules/web-ext/bin/web-ext'));

	if ((options.zip !== false && options.zip !== 0) || options.post) {
		const exclude = outZip.slice(0, outZip.lastIndexOf('-'));
		(await promisify(require('zip-dir'))(outDir, {
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
		(await new HttpRequest({ url, method: 'post', body: (await FS.readFile(outZip)), }).catch(({ target: xhr, }) => {
			if (xhr && (xhr.readyState === 4 || xhr.status === 399)) { return; } // for some reason 399
			log(`failed`);
			throw new Error(`Failed to post package`);
		}));
		log(`done`);
	}
	if (options.sign) {
		let {
			api = 'https://addons.mozilla.org/api/v3/',
			id = manifestJson.applications.gecko.id,
			key = process.env.AMO_JWT_ISSUER || process.env.JWT_ISSUER,
			secret = process.env.AMO_JWT_SECRET || process.env.JWT_SECRET,
		} = options.sign;
		if (!key || !secret) {
			const prompt = require('prompt');
			prompt.start();
			const got = (await new Promise((g, b) => prompt.get({ properties: {
				key: {
					description: 'JWT issuer',
					ask() { return !key; },
					required: true,
				},
				secret: {
					description: 'JWT secret',
					ask() { return !secret; },
					required: true, hidden: true,
				},
			}, }, (e, v) => e ? b(e) : g(v))));
			!key && (key = got.key);
			!secret && (secret = got.secret);
		}
		doLog && process.stdout.write(`Signing ... `);
		const {
			success, downloadedFiles: files,
		} = (await require('sign-addon').default({
			xpiPath: outZip, downloadDir: outDir,
			id, version: manifestJson.version,
			apiKey: key, apiSecret: secret,
			apiUrlPrefix: api, /*channel: 'unlisted',*/
		}));
		if (!success) { throw new Error('Signing failed'); }
		FS.remove(outZip); outZip = files[0]; outputName = require('path').basename(outZip);
	}
	if (options.run) {
		const run = typeof options.run === 'object' ? options.run : { };

		const firefox = typeof options.run === 'string' ? options.run : options.run.bin || ''; {
			if (firefox && (/\/|\\/).test(firefox) && (await rejects(FS.access(firefox)))) { throw new Error(`Can't access Firefox binary at "${ firefox }"`); }
		}
		const pref = Object.assign({
			'javascript.options.strict': false,
			'devtools.theme': 'dark',
		}, run.prefs);

		const app = (await require('web-ext').default.cmd.run(log('Running with options', {
			firefox, pref,
			sourceDir: outDir, artifactsDir: outDir,
			firefoxProfile: null,
			keepProfileChanges: false,
			preInstall: false,
			noReload: false,
			browserConsole: true,
			startUrl: 'about:debugging',
			ignoreFiles: null,
		}), {
			shouldExitProgram: false,
		})); void app;
	}

	return outputName;
};

async function listFiles(rootDir, include) { return (async function listFiles(parent, path, include) {
	const list = (await FS.readdir(path));
	for (const entry of (path === rootDir ? list.concat([ 'files.json', ]) : list).sort()) {
		let _include = include;
		const _path = resolve(path, entry);
		const isDir = path === rootDir && entry === 'files.json' ? false : (await FS.stat(_path)).isDirectory();
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
			(await listFiles(dir, _path, _include === true || Array.isArray(_include) ? true : _include[entry]));
		} else {
			parent[entry] = true;
		}
	} return parent;
})({ }, rootDir, include); }

async function copyFiles(files, from, to) {
	const paths = [ ];
	(function addPaths(prefix, module) {
		if (Array.isArray(module)) { return void paths.push(...module.filter(_=>_).map(file => join(prefix, file +''))); }
		Object.keys(module).forEach(key => module[key] && addPaths(join(prefix, key), module[key]));
	})('.', files);

	(await Promise.all(paths.map(path =>
		FS.copy(join(from, path), join(to, path))
		.catch(error => console.warn('Skipping missing file/folder "'+ path +'"', error.code === 'ENOENT' ? '' : error))
	)));
}
