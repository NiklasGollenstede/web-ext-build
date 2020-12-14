'use strict';

module.exports = {
	files: require('./files.js'),

	isGecko(ctx) {
		return ctx.browser === 'firefox' || ctx.browser === 'fennec';
	},
	isBlink(ctx) {
		return ctx.browser === 'chrome' || ctx.browser === 'chromium' || ctx.browser === 'opera' || ctx.browser === 'vivaldi';
	},

	runStage,
};

const V8 = require('v8');
const { functional: { debounce, }, } = require('es6lib');

/**
 * Runs stage `name` on `ctx`.
 * @param  {Context}    ctx   The current build context, which will be modified by the stage.
 * @param  {string}     name  Name of stage in `ctx.config.stages` to run.
 * @param  {function?}  next  TBD
 * @return {undefined}        TBD
 * @throws {TypeError}  If the stage returned an Iterator and `next` is not a function.
 */
async function runStage(ctx, name, next) {
	const stage = ctx.config.stages[name];
	if (!stage) { throw new Error(`Can't call missing stage ${name}`); }

	const { 1: path, 2: prop, } = (/^(.*?)(?:[:](.*))?$/).exec(stage.from);
	const loader = require(path);

	ctx.stages.current = name;
	const action = prop == null ? loader : loader[prop];
	const it = stage.options != null ? action(ctx, stage.options) : action(ctx);

	if (!it || typeof it.next !== 'function') { (await it); {
		ctx.stages.done.push(name); ctx.stages.current = null;
		if (typeof next === 'function') { (await next(ctx)); }
	} return; }

	if (!next) {
		(async () => { try { (await it.throw(new Error)); } catch { } })();
		throw new TypeError(`Must supply callback to run iterable stage`);
	}

	const loop = debounce(clone => {
		const ctx = V8.deserialize(clone);
		ctx.stages.done.push(name); ctx.stages.current = null;
		next(ctx).catch(console.error);
	}, 1e3);

	// TBD: How to iterate and await `next`. Should probably be configurable:
	// * configuration could be
	//     * part of the stage definition
	//     * the `yield` value
	// * the `next` return status (Promise) could be
	//     * ignored with errors logged
	//     * `Promise.all`ed to the caller
	//     * returned to `yield` (passed to `it.next()`)

	for await (const { } of it) { loop(V8.serialize(ctx)); }
}
