'use strict'; // license: MPL-2.0

const FS = require('fs-extra');

const { files, isGecko, } = require('../util/');

/**@typedef {import('../util/types').Context} Context*/

async function writeFs(/**@type{Context}*/ctx, /**@type{Record<String, any>}*/{ to, name, clear, linkFiles, onlyGenerated, } = { }) {

	/*const FS = {
		async ensureDir(path)           { console.log(`mkdir ${path}`); },
		async emptyDir(path)            { console.log(`clear ${path}/*`); },
		async ensureSymlink(file, name) { console.log(`link  ${name} -> ${file}`); },
		async outputFile(file, data)     { console.log(`write ${file}: ${data.length} chars`); },
	};*/

	const target = ctx.rootDir +'/'+ (to || 'build') +'/'+ (name || ctx.browser || 'default') +'/';
	(await FS.ensureDir(target));

	clear && (await FS.emptyDir(target).catch(clear === 'try'
		? () => console.warn(`Failed to clear output dir ${target}`) : null
	));

	async function dump(children) { return Promise.all(Object.values(children).map(async file => { if (file) {
		if (onlyGenerated && !file.generated) { return; }
		if (file.children) {
			!onlyGenerated && (await FS.ensureDir(target + file.path).catch(() => null));
			(await dump(file.children));
		} else {
			if (linkFiles && file.diskPath) {
				(await FS.ensureSymlink(file.diskPath, target + file.path, ));
			} else {
				(await FS.outputFile(target + file.path, file.content, 'utf-8'));
			}
		}
	} })); }

	(await dump(ctx.files));
}


async function writeZip(/**@type{Context}*/ctx, /**@type{Record<String, any>}*/{ to, name, } = { }) {
	const zip = new (require('jszip'));

	(function dump(zip, children) { Object.values(children).map(file => { if (file) {
		const name = files.splitPath(file.path).pop();
		if (file.children) {
			dump(zip.folder(name), file.children);
		} else {
			zip.file(name, file.content);
		}
	} }); })(zip, ctx.files);

	ctx.zipBlob = (await zip.generateAsync({
		type: 'nodebuffer', platform: /**@type{any}*/(process.platform),
		compression: "DEFLATE", compressionOptions: { level: 6, },
	}));

	if (name === false) { return; } // keep in memory only

	name || (name = ctx.package.name + (ctx.idSuffix || '') +'-'+ ctx.manifest.version +'-'+ ctx.browser +'.zip');
	ctx.zipPath = ctx.rootDir +'/'+ (to || 'build') +'/'+ name;

	(await FS.outputFile(ctx.zipPath, ctx.zipBlob));
}


async function pushStore(/**@type{Context}*/ctx, /**@type{Record<String, any>}*/{
	to, externalFile,
	// api = 'https://addons.mozilla.org/api/v3/',
	key = process.env.AMO_JWT_ISSUER || process.env.JWT_ISSUER,
	secret = process.env.AMO_JWT_SECRET || process.env.JWT_SECRET,
} = { }) {
	if (!isGecko(ctx)) { console.warn(`Auto signing is only implemented for Mozilla extensions, skipping for: ${ctx.browser}`); return; }
	if (!externalFile && !ctx.zipPath && !ctx.zipBlob) { throw new Error('Must supply `externalFile` or run `write-zip` stage before signing'); }

	if (!key || !secret) {
		const prompt = require('prompt');
		prompt.start();
		const got = (await new Promise((g, b) => prompt.get([ { properties: {
			key: {
				description: 'JWT issuer',
				ask() { return !key; },
				required: true,
			},
			secret: {
				description: 'JWT secret',
				ask() { return !secret; },
				required: true, ...{ hidden: true, },
			},
		}, }, ], (e, v) => e ? b(e) : g(v))));
		!key && (key = got.key);
		!secret && (secret = got.secret);
	}

	const tempFile = !externalFile && !ctx.zipPath && ctx.zipBlob ? require('os').tmpdir() +'/'+ Math.random().toString(16).slice(2) : '';
	if (tempFile) { (await FS.outputFile(tempFile, ctx.zipBlob)); }
	const downloadDir = ctx.rootDir +'/'+ (to || 'build'); (await FS.ensureDir(downloadDir));

	console.info(`Signing ... `);
	const {
		success, downloadedFiles: files,
	} = (await /**@type{(typeof import('sign-addon/src/index.js'))['default']['signAddon']} */(require('sign-addon').signAddon)({
		xpiPath: externalFile || ctx.zipPath || tempFile, downloadDir,
		id: ctx.manifest.applications.gecko.id, version: ctx.manifest.version,
		apiKey: key, apiSecret: secret,
		/*apiUrlPrefix: api,*/ /*channel: 'unlisted',*/
	}));
	if (!success || !files.length) { throw new Error('Signing failed'); }
	ctx.signedZipPath = files[0];

	if (tempFile) { (await FS.remove(tempFile)); }
}

module.exports = {
	'write-fs': writeFs,
	'write-zip': writeZip,
	'push-store': pushStore,
};
