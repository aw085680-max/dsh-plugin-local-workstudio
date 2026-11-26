import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {writeFile} from "node:fs/promises";
const UI_LOAD_MARKER=Object.freeze({
 build:"local-workstudio-v1.1.0",pid:process.pid,module:import.meta.url,loadedAt:new Date().toISOString(),
 hostSha256:createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex").toUpperCase(),
 clientModule:new URL("./client.js",import.meta.url).href,
 clientSha256:createHash("sha256").update(readFileSync(new URL("./client.js",import.meta.url))).digest("hex").toUpperCase()
});
/** Host registration proof; the delivered browser asset is fingerprinted at module load. */
function apply(ctx){
 const path=process.env.DSH_AGENT_COMMUNITY_RELAY_STARTUP_RECEIPT;
 if(path)void writeFile(path+".ui.json",JSON.stringify(UI_LOAD_MARKER),{flag:"wx"}).catch(error=>ctx.logger?.warn?.("Bots UI load receipt: "+String(error)));
}
export {apply,UI_LOAD_MARKER};

