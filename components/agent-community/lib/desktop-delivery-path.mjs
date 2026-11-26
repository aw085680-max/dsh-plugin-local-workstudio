import {createHash, randomUUID} from "node:crypto";
import {link, mkdir, readFile, realpath, unlink, writeFile} from "node:fs/promises";
import {basename, dirname, extname, isAbsolute, join, relative, sep} from "node:path";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const shellLimit = 240;

// The archive remains authoritative. Windows shell applications also get a compact,
// content-addressed location on the same host, without overwriting user edits.
export async function desktopDeliveryPath(home, file) {
  if (process.platform !== "win32" || file.path.length <= shellLimit || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? "")) return file.path;
  const root = await realpath(home);
  const archive = join(root, "agent-community", "team-tasks", "deliveries");
  const source = await realpath(file.path);
  const suffix = relative(archive, source);
  if (!suffix || suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix)) return file.path;

  const top = join(root, "交付成品");
  const directory = join(top, file.sha256);
  const name = basename(source);
  const ext = extname(name);
  const limit = shellLimit - directory.length - 1;
  if (limit < ext.length + 2) return file.path;
  const shortName = name.length <= limit ? name : "成品" + ext;
  const target = join(directory, shortName);
  for (const dir of [top, directory]) {
    await mkdir(dir, {recursive:true});
    if (relative(dir, await realpath(dir)) !== "") throw Error("成品目录被重定向");
  }
  const inspect = async () => {
    if (relative(target, await realpath(target)) !== "" || hash(await readFile(target)) !== file.sha256)
      throw Error("短路径里的文件已变动，请从原单预览原件");
  };
  try { await inspect(); return target; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const bytes = await readFile(source);
  if (hash(bytes) !== file.sha256) throw Error("原件与本版交付回执不一致");
  const pending = join(dirname(target), "." + randomUUID());
  try {
    await writeFile(pending, bytes, {flag:"wx", mode:0o600, flush:true});
    try { await link(pending, target); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await inspect();
    return target;
  } finally { await unlink(pending).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
