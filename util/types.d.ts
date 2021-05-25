/* eslint-disable */

import Config from '../config';
import { PackageJson } from 'type-fest';

export interface Context {
	config: Config['config'],
	pipeline: Config['pipeline'],
	stages: { current: string, done: string[], },
	browser: 'firefox'|'chrome'|'fennec'|'chromium'|'opera'|'vivaldi', buildNumber: null|number|string,
	idSuffix: string, nameSuffix: string, versionInfix: string,
	rootDir: string, files: FileNode['children'], fileRoot: FileNode,
	manifest: any,
	package: PackageJson|any,
	importMap: { imports: Record<string, string>, },
	zipBlob?: Buffer, zipPath?: string,
	[key: string]: any,
}

export interface Stage {
	name: string,
	from?: string,
	options?: Record<string, any>,
	action?: StageAction,
	initial?: boolean,
	final?: boolean,
}

export interface StageAction {
	(ctx: Context, options: any): Promise<any>|any,
}


export type Pipeline = (string|Pipeline[])[];
export type BranchedPipeline = [ ...string[], BranchedPipeline[], ];
export type ResolvedPipeline = string[]|BranchedPipeline;

export interface ConfigFile {
	include?: string|string[],
	pipelines: Record<string, Pipeline>,
	stages: Record<string, string | Partial<Omit<Stage, 'action'>>>,
}

export interface FileNode {
	parent: FileNode,
	path: string,
	generated?: true|boolean, stat?: Readonly<import('fs').Stats>, diskPath?: string,
	children?: Record<string, FileNode>, content?: string | Buffer,
}
