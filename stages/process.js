'use strict'; // license: MPL-2.0

const { object: { cloneOnto, }, } = require('es6lib');

const { files, isGecko, isBlink, runStage, } = require('../util/');


function setState(ctx, state) {
	cloneOnto(ctx, state);
}

async function betaInfer(ctx, { force, } = { }) {
	const build = force || process.env.BUILD_NUMBER || process.env.APPVEYOR_BUILD_NUMBER || 0; // TODO
	if (!build) { return; }
	const options = ctx.config.stages['beta-set'].options || (ctx.config.stages['beta-set'].options = { });
	cloneOnto(options, { buildNumber: build, });
	(await runStage(ctx, 'beta-set'));
}

function buildManifest(ctx, { delete: _delete, set, } = { }) {
	if (!ctx.files || !ctx.files['package.json']) { throw new Error('No package.json file loaded!'); }

	const id = /*!isGecko(ctx) ? 'TBD' :*/ '@'+ ctx.package.name + (ctx.idSuffix || '');

	const defaultIcon = { 64: files.has(ctx, 'icon.svg') && !isBlink(ctx) ? '/icon.svg' : '/icon.png', };

	const autoManifest = {
		manifest_version: 2,
		name: ctx.package.title + ctx.nameSuffix,
		short_name: ctx.package.title,
		version: ctx.package.version + (ctx.versionInfix ? isBlink(ctx) ? '.' : ctx.versionInfix : '') + (ctx.buildNumber || ''),
		author: ctx.package.author,
		description: ctx.package.description,
		homepage_url: ctx.package.homepage,

		icons: defaultIcon,

		minimum_chrome_version: '55.0.0',
		applications: {
			gecko: /*!isGecko(ctx) ? undefined :*/ {
				id, strict_min_version: '59.0',
			},
		},

		permissions: [ 'storage', ],
		optional_permissions: [ ],
		web_accessible_resources: [ ], // must be empty
		incognito: 'spanning', // firefox only supports 'spanning'
		content_scripts: [ ],

		background: files.has(ctx, 'background/index.js') ? {
			page: undefined,
			scripts: [ 'background/index.js', ],
			persistent: false,
		} : undefined,
	};

	ctx.manifest = cloneOnto(autoManifest, ctx.manifest || { });
	_delete.forEach(prop => {
		if (typeof prop === 'string') { prop = [ prop, ]; }
		const name = prop.pop(), obj = prop.reduce((obj, key) => obj && obj[key]);
		obj && delete obj[name];
	});
	cloneOnto(ctx.manifest, set);

	ctx.manifest.content_scripts && !ctx.manifest.content_scripts.length && delete ctx.manifest.content_scripts; // empty array causes 0x80070490 in edge

	ctx.files['manifest.json'] = {
		parent: null, generated: true, path: '/manifest.json',
		get content() { return JSON.stringify(ctx.manifest, null, '\t'); },
	};
}

function setWebExtUpdateUrl(ctx, { host, } = { }) {

	const [ , ghUser, ghRepo, ] = (/^(?:https:\/\/github\.com\/|git@github\.com:)([\w-]+)\/([\w-]+?)(?:\.git)?$/).exec(
		ctx.package.repository && ctx.package.repository.url || ctx.package.repository
	) || [ ];

	if (!ghRepo) { throw new Error(`Unable to parse GitHub repo from package.json#repository`); }

	if (isGecko(ctx)) {
		const id = ctx.manifest.applications.gecko.id; ctx.manifest.applications.gecko.update_url
		= `https://${ host || 'update-manifest.niklasg.de' }/xpi.json?user=${ghUser}&repo=${ghRepo}&id=${id}`;
	} else { throw new Error(`Not implemented`); }
}


module.exports = {
	'set-state': setState,
	'beta-infer': betaInfer,
	'build-manifest': buildManifest,
	setWebExtUpdateUrl,
};
