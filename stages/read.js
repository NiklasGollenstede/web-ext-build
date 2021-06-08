'use strict'; // license: MPL-2.0

const FS = require('fs-extra'), Path = require('path');
const { PassThrough, } = require('stream');
const { object: { deepFreeze, }, } = require('es6lib');
const DotIgnore = require('dotignore');
const precinct = require('precinct');

const { files: Files, getAction, } = require('../util/');

/** @typedef {import('../util/types').FileNode} FileNode */
/** @typedef {import('../util/types').Context} Context */

async function readFs(/**@type{Context}*/ctx, /**@type{Record<String, any>}*/{ from, ignorefile, ignore, importMap, }) {
	const rootPath = Path.resolve(ctx.rootDir, from);

	const ignoreLines = [ // If any of these are _not_ to be ignored, add then to `ignore` with a leading `!`.
		'.*', // All hidden files or dirs.
		'/node_modules/', // Top level node_modules, contains this tool and other stuff that should not be included. WHitelist as needed.
		// The build target dir should also not be included, but build targets can be produced by any number of stages to any location. Let's assume the repos ignore file takes care of that.
		// '!/'+ ignorefile, // this doesn't work, `dotignore` has a bug with '!/', maybe related to https://github.com/bmeck/dotignore/issues/8
	].join('\n') +'\n'+ ((await
		FS.readFile(Path.resolve(rootPath, ignorefile)).catch(() => (console.warn(`Ignoring missing ignorefile ${ignorefile}`), ''))
	) +'\n'+ ignore)
	.replace(/^#.*/gm, '');
	const matcher = DotIgnore.createMatcher(ignoreLines);

	const fileRoot = ctx.fileRoot = (await Files.makeNode(null, rootPath, '', path => !matcher.shouldIgnore(path) || path === ignorefile));
	const root = ctx.files = fileRoot.children;

	if (root['package.json']) {
		ctx.package = deepFreeze(JSON.parse(/**@type{string}*/(root['package.json'].content)));
	}

	if (typeof importMap === 'string') { try {
		importMap = (await FS.readJSON(Path.resolve(rootPath, importMap)));
	} catch (error) {
		console.warn(`Ignoring missing importMap file ${importMap}`);
	} }
	if (importMap != null) { if (importMap.imports && typeof importMap.imports === 'object' && Object.values(importMap.imports).every(value => typeof value === 'string')) {
		Object.assign(ctx.importMap.imports, importMap.imports);
	} else {
		console.warn(`importMap.imports must be of type Record<string, string>; ignored`);
	} }
}

async function * watchFs(/**@type{Context}*/ctx, /**@type{Record<String, any>}*/options) {
	// TODO: what to do if `web-ext-build.yml` or `ignorefile` changes?
	// TODO: if `package.json` changes, re-parse it to `ctx.package`
	(yield true); (await new Promise(wake => setTimeout(wake, 2e3))); // initial build
	let { from, add, exclude, include: _include, } = /**@type{Record<String, any>}*/({ ...ctx.config.stages['read-fs'].options, ...options, });
	exclude = new RegExp(exclude || '$.'); _include = new RegExp(_include || '$.');
	const stream = new PassThrough({ objectMode: true, });
	let recursive; try { recursive = FS.watch(
		ctx.rootDir +'/'+ from, { recursive: true, }, (_, path) => stream.write({
			diskPath: ctx.rootDir +'/'+ from +'/'+ path, virtPath: path,
		}),
	); } catch { }
	const watchers = [
		recursive, // `recursive` doesn't always work, so listen on each folder explicitly
		...Files.list(ctx.files)/* .filter(_=>_.endsWith('/')) */.map(path => {
			const file = Files.get(ctx, path); if (!file?.diskPath) { return null; }
			return FS.watch(file.diskPath, (_, name) => stream.write({
				diskPath: file.diskPath + (file.children ? '/'+ name : ''), virtPath: path + (file.children ? name : ''),
			}));
		}).filter(_=>_),
		...Object.entries(add || { }).map(({ 0: path, 1: to, }) => FS.watch(
			ctx.rootDir +'/'+ path, () => stream.write({
				diskPath: ctx.rootDir +'/'+ path, virtPath: to || path,
			}),
		)),
	];
	watchers.forEach(_=>_?.on('error', e => stream.destroy(e)));
	console.info('watching', watchers.filter(_=>_).length, 'files or folders');

	let lastTime = Date.now(), lastPath = '';
	try { for await (const { diskPath, virtPath, } of stream) {
		if (lastPath === (lastPath = virtPath) && lastTime - (lastTime = Date.now()) > -1e3) { continue; } lastTime = Date.now();
		if (exclude.test(virtPath) && !_include.test(virtPath)) { continue; }
//		console.info('file changed', diskPath, virtPath);

		const file = Files.get(ctx, virtPath); if (file) {
			if (file.generated) { continue; }
			try {
				file.content = Files.tryUnicode((await FS.readFile(diskPath)));
			} catch (error) { if (error?.code === 'ENOENT') {
				if (!Files.remove(file)) { throw error; }
			} else { throw error; } }
		} else {
			try {
				(await Files.addAs(ctx.fileRoot, diskPath, virtPath));
			} catch (error) { if (error?.code !== 'ENOENT') { throw error; } }
		} (yield true);
	} } finally {
		watchers.forEach(_=>_?.close());
		stream.destroy();
	}
}

const defaultTracers = {
	precinct: {
		action(options) { const deps = precinct(options.code, options).map(id => ({ id, })); return !deps.length ? null : deps; },
		options: { }, name: 'precinct',
	},
};

async function importDeps(/**@type{Context}*/ctx, /**@type{Record<String, any>}*/{ tracers = { }, } = { }) {
	const _tracers = { ...defaultTracers, };

	Object.entries(tracers).reverse().forEach(([ key, stageName, ]) => {
		if (stageName == null) { delete _tracers[key]; return; }
		if (ctx.config.stages[stageName]) { _tracers[key] = ctx.config.stages[stageName]; }
		else { throw new Error(`Can't find stage named ${stageName} for dependency tracing`); }
	});

	const files = Files.list(ctx.files).map(path => Files.get(ctx, path));

	for (let index = 0; index < files.length; ++index) {
		const file = files[index]; if (typeof file.content !== 'string') { continue; }
		for (const tracer of Object.values(_tracers).reverse()) {
			/**@type{{ raw?: string, id: string, ext?: string, }[] | null}*/const deps = (await /**@type{any}*/(getAction(tracer))({
				...(tracer.options || { }), code: file.content, path: file.path,
			})); if (!deps/*?.length*/) { continue; }

			/// resolve imports following (a subset of) the import map proposal
			if (file.path.endsWith('.esm.js')) { deps.forEach(dep => {
				let { id, ext, } = dep; ext && (id += '.'+ ext);
				if (id.endsWith('/') || id.startsWith('.')) { return; }
				/**@type{string}*/let path;
				for (const prefix of Object.keys(ctx.importMap.imports)) {
					if (prefix.endsWith('/')) {
						if (id.startsWith(prefix)) { path = ctx.importMap.imports[prefix] + id.slice(prefix.length); }
					} else {
						if (id === prefix) { path = ctx.importMap.imports[prefix]; }
					} if (path) { break; }
				} if (!path) { return; }
				dep.raw = dep.raw ?? id;
				dep.id = path.replace(/^[/]/, ''); dep.ext = undefined;
				const _id = id.replace(/[\[\]\{\}\(\)\*\+\?\.\\\/\^\$\|\#]/g, '\\$&'); /* escape */ // eslint-disable-line no-useless-escape
				file.content = /**@type{string}*/(file.content).replace(
					new RegExp(String.raw`([^.])(?:(\s+from\s+)(['"])${_id}\3|(\s+import\s*[(]\s*)(['"])${_id}\5[)])`),
					(_, _1, _2, _3, _4, _5) => _1 + (_2 ? _2 + _3 + path + _3 : _4 + _5 + path + _5 +')'),
				);
			}); }

			(await Promise.all(deps.map(async ({ raw, id, ext, }) => {
				raw = raw ?? id; id.endsWith('/') && ext && (id += 'index'); ext && (id += '.'+ ext);
				const path = id.startsWith('.') ? Path.resolve('/', file.path, '..', id).slice(1) : id.startsWith('/') ? id.slice(1) : id;
				const newFile = (await Files.addModule(ctx, path).catch(error => {
					console.warn(`Error when loading dependency '${ raw !== id ? raw +"' as '"+ id : id }' of '${file.path}'`); throw error;
				}));
				if (!files.some(_=>_.path === path)) { files.push(newFile); }
			}))); break;
		}
	}
}


module.exports = {
	'read-fs': readFs,
	'watch-fs': watchFs,
	'import-deps': importDeps,
};
