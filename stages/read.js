'use strict'; // license: MPL-2.0

const FS = require('fs-extra'), Path = require('path');
const { PassThrough, } = require('stream');
const { object: { deepFreeze, }, } = require('es6lib');
const DotIgnore = require('dotignore');

const { files, } = require('../util/');


async function readFs(ctx, { from, ignorefile, ignore, }) {
	const rootPath = Path.resolve(ctx.rootDir, from);

	const ignoreLines = [ // If any of these are _not_ to be ignored, add then to `ignore` with a leading `!`.
		'.*', // All hidden files or dirs.
		'/node_modules/', // Top level node_modules, contains this tool and other stuff that should not be included. WHitelist as needed.
		// The build target dir should also not be included, but build targets can be produced by any number of stages to any location. Let's assume the repos ignore file takes care of that.
		// '!/'+ ignorefile, // this doesn't work, `dotignore` has a bug with '!/', maybe related to https://github.com/bmeck/dotignore/issues/8
	].join('\n') +'\n'+ ((await
		FS.readFile(Path.resolve(rootPath, ignorefile)).catch(error => (console.warn(`Ignoring missing ignorefile ${ignorefile}`), ''))
	) +'\n'+ ignore)
	.replace(/^#.*/gm, '');
	const matcher = DotIgnore.createMatcher(ignoreLines);

	const fileRoot = ctx.fileRoot = (await files.makeNode(null, rootPath, '', path => !matcher.shouldIgnore(path) || path === ignorefile));
	const root = ctx.files = fileRoot.children;

	if (root['package.json']) {
		ctx.package = deepFreeze(JSON.parse(root['package.json'].content));
	}
}

async function _readFs(ctx, { from = './', ignorefile, ignore, } = { }) {
	const root = ctx.files = ctx.files || { __proto__: null, };
	const fileRoot = ctx.fileRoot = { parent: null, generated: true, path: '', children: root, };

	exclude = new RegExp(exclude || '$.'); _include = new RegExp(_include || '$.');

	(await files.addChildren(fileRoot, ctx.rootDir +'/'+ from, path =>
		!exclude.test(path) || _include.test(path)
	));

	for (const { 0: path, 1: to, } of Object.entries(add || { })) {
		try { (await FS.stat(ctx.rootDir +'/'+ path)); }
		catch { console.warn(`Not adding missing file ${path}`); }
		(await files.addAs(fileRoot, ctx.rootDir +'/'+ path, to || path));
	}

	if (root['package.json']) {
		ctx.package = deepFreeze(JSON.parse(root['package.json'].content));
	}
}

async function * watchFs(ctx, options) {
	// TODO: what to do if `web-ext-build.yml` or `ignorefile` changes?
	// TODO: if `package.json` changes, re-parse it to `ctx.package`
	(yield true); (await new Promise(wake => setTimeout(wake, 2e3))); // initial build
	let { from, add, exclude, include: _include, } = { ...ctx.config.stages['read-fs'].options, ...options, };
	exclude = new RegExp(exclude || '$.'); _include = new RegExp(_include || '$.');
	const stream = new PassThrough({ objectMode: true, });
	let recursive; try { recursive = FS.watch(
		ctx.rootDir +'/'+ from, { recursive: true, }, (_, path) => stream.write({
			diskPath: ctx.rootDir +'/'+ from +'/'+ path, virtPath: path,
		}),
	); } catch { }
	const watchers = [
		recursive, // `recursive` doesn't always work, so listen on each folder explicitly
		...files.list(ctx.files)/* .filter(_=>_.endsWith('/')) */.map(path => {
			const file = files.get(ctx, path); if (!file || !file.diskPath) { return null; }
			return FS.watch(file.diskPath, (_, name) => stream.write({ diskPath: file.diskPath +'/'+ name, virtPath: path +'/'+ name, }));
		}).filter(_=>_),
		...Object.entries(add || { }).map(({ 0: path, 1: to, }) => FS.watch(
			ctx.rootDir +'/'+ path, () => stream.write({
				diskPath: ctx.rootDir +'/'+ path, virtPath: to || path,
			}),
		)),
	];
	watchers.forEach(watcher => watcher && watcher.on('error', e => stream.destroy(e)));
	console.info('watching', watchers.filter(_=>_).length, 'files or folders');

	let lastTime = Date.now(), lastPath = '';
	try { for await (const { diskPath, virtPath, } of stream) {
		console.log('change', { diskPath, virtPath, });
		if (lastPath === (lastPath = virtPath) && lastTime - (lastTime = Date.now()) > -1e3) { continue; }
		if (exclude.test(virtPath) && !_include.test(virtPath)) { continue; }
		console.info('file changed', diskPath, virtPath);

		const file = files.get(ctx, virtPath); if (file) {
			if (file.generated) { continue; }
			file.content = files.tryUnicode((await FS.readFile(diskPath)));
		} else {
			(await files.addAs(ctx.fileRoot, diskPath, virtPath));
		} (yield true);
	} } finally {
		watchers.forEach(_=>_.close());
		stream.destroy();
	}
}


module.exports = {
	'read-fs': readFs,
	'watch-fs': watchFs,
};
