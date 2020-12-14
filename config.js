'use strict'; // license: MPL-2.0

const YAML = require('js-yaml');
const { posix: Path, } = require('path');
const FS = require('fs-extra');
const Module = require('module');

const { object: { cloneOnto, deepFreeze, }, } = require('es6lib');


/*!
 * Configuration builder.
 * @property {string}  root    Path of the project root of the extension,
 *                             containing the `package.json` and optionally a `web-ext-build.yaml`.
 * @property {object}  config  Merged and validated configuration from all `include`ed locations.
 *                             Any `include`s are resolved, `piplines` is format-validated,
 *                             and all `stages##from` have been replaced by the functions they reference.
 */
module.exports = class Config {
	constructor() {
		this.root = null;
		this.config = {
			pipelines: { },
			stages: { },
		};
		this.pipeline = null;
	}

	//! Initialize the default config, then load the custom config starting in the project root.
	async load(root) {
		this.root = require('find-root')(root);
		(await this.includeModule(module, __dirname));
		(await this.includeModule(module, this.root, /*optional:*/true));
	}

	//! Include additional `stages##options` passed as YAML on the command line,
	//! as any number of objects `{ [stageNameOrAlias]: stageOptions, ... }`.
	cli(args) {
		args.forEach((arg, index) => {
			const stages = YAML.safeLoad(arg, { filename: 'cli:'+ index, });
			Object.entries(stages).forEach(({ 0: name, 1: options, }) => {
				stages[name] = { options, };
			});
			this.addStages(null, stages, 'cli:'+ index);
		});
	}

	//! Include from a reference to either a module or a specific YAML file.
	async include(parent, path) {
		if (!(/[/\\]/).test(path)) { (await this.includeModule(parent, path)); }
		else if ((/[.]yaml$/).test(path)) { // note that this loads the new file with the old module (i.e. additional includes and `from` resolution will be relative to the previous module)
			(await this.includeYaml(parent, parent.require.resolve(path)));
		} else { throw new Error(`Invalid include path: ${path}`); }
	}

	//! Include from a module, either from the `web-ext-build.yaml` or from `package.json#config.web-ext-build`.
	async includeModule(parent, path, optional) {
		const modulePath = Module._resolveFilename(path +'/package.json', parent, false);
		require(modulePath); const module = require.cache[modulePath];
		const yamlPath = Path.join(modulePath, '../web-ext-build.yaml');
		const yamlExists = (await FS.stat(yamlPath).catch(() => null));
		if (yamlExists) { (await this.includeYaml(module, yamlPath)); }
		else if (module.exports.config && module.exports.config['web-ext-build'])
		{ (await this.includeRaw(module, module.exports.config['web-ext-build'], modulePath)); }
		else if (!optional) { throw new Error(`Could not find config in module ${modulePath}`); }
	}

	//! Include from a YAML file.
	async includeYaml(module, path) {
		const yaml = YAML.safeLoad((await FS.readFile(path)), { filename: path, });
		(await this.includeRaw(module, yaml, path));
	}

	//! Actually include a config snippet that was read.
	async includeRaw(module, config, path) {
		if (!config) { return; }
		if (config.include) { if (Array.isArray(config.include)) {
			(await Promise.all(config.include.map(include => this.include(module, include))));
		} else {
			(await this.include(module, config.include));
		} }
		if (config.pipelines && typeof config.pipelines === 'object') { (await this.addPipelines(module, config.pipelines, path)); }
		if (config.stages && typeof config.stages === 'object') { (await this.addStages(module, config.stages, path)); }
	}

	//! Validate and add the `pipelines` property from a config snippet.
	addPipelines(module, pipelines, path) {
		for (const { 0: name, 1: stages, } of Object.entries(pipelines)) {
			isStages(stages); this.config.pipelines[name] = deepFreeze(stages);
		} function isStages(stages) { {
			if (!Array.isArray(stages) || !stages.every(stage => typeof stage === 'string'
				|| Array.isArray(stage) && stage.every(isStages)
			)) { throw new Error(`'pipelines' entries must be strings or arrays of arrays of strings (in ${path})`); }
		} return true; }
	}

	//! Validate and add the `stages` property from a config snippet.
	//! Writes string references as getter properties, and resolves
	//! the `from` subkey and loads the function it references in its place.
	addStages(module, stages, path) {
		for (const { 0: name, 1: stage, } of Object.entries(stages)) {
			if (typeof stage === 'string') {
				this.config.stages[name] = null;
				Object.defineProperty(this.config.stages, name, {
					get() { return this[stage]; },
					set(value) { Object.defineProperty(this, name, { value, }); },
				});
				continue;
			}
			if (typeof stage !== 'object' || !stage) {
				throw new Error(`Stage ${name} is not an object or alias (in ${path})`);
			}
			if ('from' in stage) {
				if (typeof stage.from !== 'string')
				{ throw new Error(`Stage ${name}.from must be a string (in ${path})`); }
				let { 1: loaderPath, 2: prop, } = (/^(.*?)(?:[:](.*))?$/).exec(stage.from);
				loaderPath = Module._resolveFilename(loaderPath, module, false);
				const loader = require(loaderPath);
				if (typeof (prop == null ? loader : loader[prop]) !== 'function')
				{ throw new Error(`stages.${name}.from = '${stage.from}' did not load a function (in ${path})`); }
				stage.from = loaderPath + (prop != null ? ':'+ prop : '');
			}
			!this.config.stages[name] && (this.config.stages[name] = { });
			cloneOnto(this.config.stages[name], stage);
		}
	}

	//! Gets a pipeline from `.config.pipelines` and fully resolves it:
	//! 1) If an entry is a pipeline name, the named pipeline's entries are spread in its place (recursively).
	//! 2) If the first entry is not an initial stage (including if it is an array), the start-default pipeline (prepared as in step 1) will be prepended. The list must now start with an initial stage.
	//! 3) If, starting at the back of the list, an entry is a list, whose children must be lists themselves, any entries after that list of lists will be moved to each sublist.
	//! 4) If the last stage of any sub list is not a final stage, the end-default pipeline (prepared as in steps 1 and 3) will be appended. Each sub list must now end with a final stage.
	getNormalizedPipeline(name) {
		const { pipelines, stages, } = this.config;
		function get(name) {
			const line = pipelines[name]; if (line) { return line; }
			throw new Error(`No such pipeline ${name}`);
		}
		function getStage(name) {
			const stage = stages[name]; if (stage) { return stage; }
			throw new Error(`No such stage ${name}`);
		}

		// (1)
		function resolve(line) {
			const out = [ ]; line.forEach(name => { if (Array.isArray(name)) {
				out.push(name.map(resolve));
			} else {
				const other = pipelines[name];
				if (other) { out.push(...resolve(other)); }
				else { getStage(name); out.push(name); }
			} }); return out;
		}
		const main = resolve(get(name));

		// (2)
		if (Array.isArray(main[0]) || !getStage(main[0]).initial) {
			main.unshift(...resolve(get('start-default')));
		}

		// (3)
		function expand(list) {
			for (let i = list.length - 1; i >= 0; i--) {
				if (!Array.isArray(list[i])) { continue; }
				const rest = list.splice(i + 1, Infinity);
				list[i].forEach(_=>_.push(...rest));
			} return list;
		}
		expand(main);

		// (4)
		let end; function getEnd() { return end || (end = expand(resolve(get('end-default')))); }
		function append(list) {
			if (checked.has(list)) { return; } checked.add(list);
			const tail = list[list.length - 1];
			if (Array.isArray(tail)) { tail.forEach(append); }
			else if (!getStage(tail).final) { list.push(...getEnd()); }
		} const checked = new WeakSet;
		append(main);

		return main;
	}
};
