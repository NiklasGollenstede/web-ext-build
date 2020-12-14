
# A build tool for WebExtensions

WebExtBild is an extensible building framework for reading, processing, bundling, and deploying source code into software bundles.
It is currently equipped to zip and sign WebExtenbsions.


## 🚧 WIP 🚧

This tool just underwent a complete redesign and rewrite. The design still wants to be proven, and the writing completed.
At this point, the documentation isn't meant to promote use of this tool by other project, but as a point of reference for future development on the tool, and for use with my extensions.


## Usage

`web-ext-build` is supposed to be installed as a local dependency and then used as `npm` scripts or via `npx`. E.g.:
```json
"dependencies": {
    "web-ext-build": "<version>",
},
"scripts": {
    "build": "web-ext-build",
    "dev": "web-ext-build watch",
    "sign": "web-ext-build sign"
},
```
For more details on the CLI and build customization, see below.


## Design

Each invocation of the tool transforms the source code from some input medium through any number of processing steps to one or more output targets.
The processing is performed by _Stages_ along a _Pipeline_. The first Stage must read the source, e.g. from a file system directory or a ZIP file, consecutive stages may perform any transformations on the in-memory state, e.g. loading dependencies or combining/optimizing files, and the last Stage(s) should output the software, e.g. to the File system, a ZIP, or some upload location.
While each Stage has exactly one predecessor, it may have multiple successors, thus allowing to build for multiple targets in one invocation.
A stage may also pass to its successor(s) more than once, allowing for example watch mechanics.

The pipeline to run is deducted from YAML files and snippets, and the name of the pipeline specified on command line.
The YAML files specify the following structure:
* `pipelines` as a named set of `pipeline`s, where each one is a list.
    * `pipeline` list entries may be `stage` names, `pipeline` names or lists of lists thereof.
* `stages` as a named set of `stage`s, where each one is defined as an object of `{ from, options, initial, final, }`:
    * `from` is a string `<module-require-path>:<name-of-exported-function>` describing the (optionally async and/or generator) function to run for this step.
    * `options` is an object of any options the function above expects.
    * `initial: true` marks an initial stage, and `final: true` marks a final stage.

This structure may be defined across multiple files. As a basis, the [`web-ext-build.yaml`](./web-ext-build.yaml) in this repository is loaded.
Then, the the `web-ext-build.yaml` next to the `package.json` closest to the `cwd` gets to overwrite/extend that configuration, and `include` additional modules.
These modules may do the same through a `web-ext-build.yaml` or `"config"."web-ext-build"` in the `package.json` in the module root.

Finally, the command line specifies the name of the pipeline to run (defaulting to `default`), plus optionally overwrites to the `options` of the `stages` defined so far (as multiple inline `{ [name]: options, ... }` yaml snippets).
Example CLI calls could be a simple `web-ext-build` without arguments, or `web-ext-build zip 'beta-infer: { force: 42 }' 'write-zip: { to: . }'` to output beta ZIP(s) with build number 42 to the CWD.

Given the name of the initial pipeline from the CLI, the pipeline steps that are actually will be derived like this from the named pipeline:
1) If an entry of the pipeline is a pipeline name, the named pipeline's entries are spread in its place (recursively).
2) If the first stage is not an initial stage, the start-default pipeline (prepared as in step 1) will be prepended. The list must now start with an initial stage.
3) If, starting at the back of the list, an entry is a list, whose children must be lists themselves, any entries after that list of lists will be moved to each sublist.
4) If the last stage of any sub list is not a final stage, the end-default pipeline (prepared as in steps 1 and 3) will be appended. Each sub list must now end with a final stage.
5) Each stage is run with the resulting state of the previous stage (or the initial state) and its options as input.
    * The initial state is empty except for the options passed on the CLI.
    * This branches (with copies of the current state) to the sub lists every time a list entry is not a stage name but a list of lists (see 3).
    * If the stage's function is a generator, it also branches with a copy whenever the generator yields.
    * The `final` stages should perform some output action.


## TODOs

* [ ] write more TODOs
* [ ] CLI: error reporting and printing usage (`--help`, `--version`)
* framework
	* [ ] logging verbosity
	* [ ] `yield` behavior, see `util/:runStage`
* stages
	* [ ] documentation
	* [ ] more stages: integration testing, Google upload
* testing
