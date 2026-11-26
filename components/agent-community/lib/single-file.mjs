import {mkdir, open, readFile, realpath, writeFile} from "node:fs/promises";
import {basename, isAbsolute, join, relative, resolve, sep} from "node:path";
import {createHash} from "node:crypto";

export function requestsSingleFile(body) {
  const text = body.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|`[^`]*`/gu, " ");
  if (/(?:不要|不用|无需|不必|别再|别给|不用给|不要给)[^。；]{0,24}(?:文件|文档|成品|附件|报告)|(?:只|仅)(?:要|用|需|在)?(?:正文|文字|群里)(?:回复|答复)/u.test(text)) return false;
  return text.split(/[。！？；;，,、\n]/u).some(clause =>
    !/(?:他说|她说|昨天|之前|提过|示例|假设|据说|为什么|有没有|是否|打不开|打开不了)/u.test(clause) &&
    /(?:给我|发我|交给我|做成|生成|导出|输出|交付|提交|发回|制作|写一份|整理成|保存为)[^。；]{0,45}(?:文件|附件|成品|文档|表格|报告|清单|[.](?:md|txt|csv|xlsx?|docx?|pdf)\b)/iu.test(clause));
}

export async function pinSingleDeliverables(files, workspace, outputRoot, origin) {
  const root = await realpath(workspace);
  const pinned = [];
  for (const file of files) {
    const source = await realpath(resolve(root, file.path));
    const inside = relative(root, source);
    if (!inside || inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) throw Error("只可交付本单成员工作目录内的成品");
    const handle=await open(source,"r");
    let bytes;
    try {
      const info=await handle.stat();
      if(!info.isFile() || info.size===0 || info.size>64*1024*1024) throw Error("单人成品须为非空且不超过 64 MB 的普通文件");
      bytes=await handle.readFile();
    } finally { await handle.close(); }
    const sha256=createHash("sha256").update(bytes).digest("hex");
    const name=basename(source), directory=join(outputRoot,sha256), path=join(directory,name);
    await mkdir(directory,{recursive:true});
    if(await realpath(directory)!==directory) throw Error("交付目录已重定向");
    try { await writeFile(path,bytes,{flag:"wx",flush:true}); }
    catch(error){if(error.code!=="EEXIST")throw error;}
    if(await realpath(path)!==path || !bytes.equals(await readFile(path))) throw Error("成品回读不一致");
    pinned.push({...file,path,name,size:bytes.length,sha256,sourceMessageId:origin});
  }
  return pinned;
}
