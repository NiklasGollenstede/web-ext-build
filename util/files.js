'use strict';

const FS = require('fs-extra');

module.exports = {
	makeNode, addChildren, addAs, addModule,
	get, has, read, list,
	splitPath, tryUnicode,
	FS,
};

const decoder = new (require('util').TextDecoder)('utf-8', { fatal: true, ignoreBOM: true, });

async function addChildren(parent, base, filter) {
	(await Promise.all((await FS.readdir(base)).map(async name => {
		parent.children[name] = (await makeNode(parent, base +'/'+ name, parent.path + name, filter));
	}))); return parent;
}
async function makeNode(parent, diskPath, virtPath, filter) {
	const stat = Object.freeze((await FS.stat(diskPath))); // TODO: how does this survive `V8.deserialize(V8.serialize(ctx))`?
	const node = { parent, stat, path: virtPath, diskPath, };
	if (stat.isFile()) {
		if (filter && !filter(virtPath)) { return undefined; }
		node.content = tryUnicode((await FS.readFile(diskPath)));
	} else if (stat.isDirectory()) {
		virtPath = node.path = virtPath ? virtPath + '/' : '';
		if (filter && !filter(virtPath)) { return undefined; }
		node.children = { __proto__: null, };
		(await addChildren(node, diskPath, filter));
	} else { throw new Error(`Unhandled FS node type for ${diskPath}`); }
	return node;
}
async function addAs(fileRoot, diskPath, virtPath, create = false) {
	const parts = splitPath(virtPath); const name = parts.pop();
	const dir = parts.reduce((dir, name) => {
		const child = dir.children[name]; if (child) {
			if (child.children) { return child; }
			throw new Error(`Can't add ${diskPath} as ${virtPath}: target parent is not a directory`);
		} else {
			if (create) { return (dir.children[name] = {
				generated: true, path: dir.path + name +'/', children: { __proto__: null, },
			}); }
			throw new Error(`Can't add ${diskPath} as ${virtPath}: target parent does not exist`);
		}
	}, fileRoot);
	return dir.children[name] || (dir.children[name] = (await makeNode(dir, diskPath, '/'+ virtPath)));
}
async function addModule(ctx, path) {
	const file = get(ctx, path); if (file) { return file; }
	return addAs(ctx.fileRoot, ctx.rootDir +'/'+ path, path.replace(/[/\\]?$/, ''), true);
}

function list(children, files = [ ]) {
	Object.values(children).forEach(file => {
		if (!file) { return; }
		if (!file.children) { files.push(file.path); return; }
		files.push(file.path +'/'); list(file.children, files);
	}); return files;
}
function get(ctx, path) {
	if (typeof path !== 'string') { return null; }
	if (path === '') { return ctx.fileRoot; }
	const parts = splitPath(path);
	return parts.reduce((dir, name) => {
		return dir && dir.children && dir.children[name];
	}, ctx.fileRoot);
}
function read(ctx, path) {
	const file = get(ctx, path);
	if (file && ('content' in file)) { return file.content; }
	throw new Error(`No such loaded file: ${path}`);
}
function has(ctx, ...paths) {
	return paths.some(path => get(ctx, path));
}

function splitPath(path) {
	return (path +'').replace(/^[/\\]|[/\\]?$/g, '').split(/[/]+/g).filter(_=>_);
}

// let's simply be opportunistic about the string decoding
function tryUnicode(buffer) { try {
	return decoder.decode(buffer);
} catch { return buffer; } }
