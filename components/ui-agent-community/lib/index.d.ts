declare function apply(ctx: {logger?: {warn?: (message:string)=>void}}): void;
declare const UI_LOAD_MARKER: Readonly<{build:string;pid:number;module:string;loadedAt:string;hostSha256:string;clientModule:string;clientSha256:string}>;
export {apply,UI_LOAD_MARKER};
