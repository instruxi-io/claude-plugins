// Baseline shim: @types/node is not a dependency, so Node built-ins are typed `any` for now.
// TODO(typecheck): replace with @types/node (a devDependency) when the baseline is tightened.
declare module 'node:*';
declare const process: any;
declare const Buffer: any;
declare type Buffer = any;
