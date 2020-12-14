'use strict'; // license: MPL-2.0

const Config = require('./config.js');
const V8 = require('v8');
const { object: { deepFreeze, }, } = require('es6lib');

const { runStage, } = require('./util/');

async function loadConfig(cwd, args) {
	const config = new Config();
	(await config.load(cwd)); config.cli(args.slice(1));

	const pipelineName = !args[0] || args[0] === '-' ? 'default' : args[0];
	config.pipeline = deepFreeze(config.getNormalizedPipeline(pipelineName));
	return config;
}

async function execConfig(config, pipeline = config.pipeline) {

	const ctx = {
		pipeline: deepFreeze(pipeline),
		stages: { done: [ ], current: null, },
		rootDir: config.root, config: config.config,
		files: null, // FileNode['children'] (= Record<string, FileNode>)
		fileRoot: null, // FileNode
		manifest: null,
		package: null,
		browser: 'firefox', buildNumber: null,
		idSuffix: '', nameSuffix: '', versionInfix: '',
	};

	(await (async function walk(stages, ctx) {
		if (!stages.length) { {
			console.info('pipeline done:', ctx.stages.done.join('|'));
		} return; }
		// console.log('walk', stages);

		const name = stages[0];
		if (Array.isArray(name)) {
			const clone = V8.serialize(ctx);
			(await Promise.all(name.map(stages => walk(stages, V8.deserialize(clone)))));
		} else {
			console.info('running:', ctx.stages.done.join('|'), '->', name);
			(await runStage(ctx, name, ctx => walk(stages.slice(1), ctx)));
		}
	})(ctx.pipeline, ctx));

	console.info('done');
}

module.exports = { loadConfig, execConfig, runStage, };
