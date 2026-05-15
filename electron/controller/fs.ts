/**
 * 文件系统控制器
 */
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import { app, net as electronNet } from 'electron';
import { BaseController } from './base';
import { validateUrl } from '../service/url-validator';
import { getDecryptedApiKey } from '../service/settings/ChannelConfigService';

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function isPathAllowed(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  const home = app.getPath('home');
  const appData = app.getPath('appData');
  const userData = app.getPath('userData');
  const temp = app.getPath('temp');
  // 业务根（~/.koma）与 userData 已分离，必须显式加进允许列表
  const businessRoot = path.join(home, '.koma');
  const allowedRoots = [home, appData, userData, temp, businessRoot];
  return allowedRoots.some(root => normalized.startsWith(root + path.sep) || normalized === root);
}

function assertPathAllowed(filePath: string): void {
  if (!isPathAllowed(filePath)) {
    throw new Error('Access denied: path outside allowed directories');
  }
}

class FsController extends BaseController {
  private static getExtensionFromContentType(contentType?: string | string[]): string | null {
    const raw = Array.isArray(contentType) ? contentType[0] : contentType;
    const mimeType = String(raw || '').split(';')[0].trim().toLowerCase();
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';
    if (mimeType === 'video/mp4') return 'mp4';
    if (mimeType === 'audio/mpeg') return 'mp3';
    if (mimeType === 'audio/wav') return 'wav';
    return null;
  }

  private static replaceExtension(filePath: string, extension: string): string {
    const parsed = path.parse(filePath);
    return path.join(parsed.dir, `${parsed.name}.${extension}`);
  }

  private static buildDownloadHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Koma/1.0 Safari/537.36',
      'Accept': 'video/mp4,video/*,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Connection': 'close',
      ...(extraHeaders || {}),
    };
  }

  private static buildAuthHeaders(args: { headers?: Record<string, string>; channelId?: string }): Record<string, string> {
    const out: Record<string, string> = {};
    const input = args.headers || {};
    for (const [key, value] of Object.entries(input)) {
      const normalized = key.toLowerCase();
      if (normalized === 'authorization' || normalized === 'x-koma-channel-id') {
        out[key] = String(value);
      }
    }
    if (!Object.keys(out).some(k => k.toLowerCase() === 'authorization') && args.channelId) {
      const apiKey = getDecryptedApiKey(args.channelId);
      if (apiKey) out.Authorization = `Bearer ${apiKey}`;
    }
    return out;
  }

  private static async writeResponseToFile(response: Response, requestedPath: string): Promise<{ success: true; size: number; path: string; mimeType?: string }> {
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || undefined;
    const extension = FsController.getExtensionFromContentType(mimeType);
    const destPath = extension ? FsController.replaceExtension(requestedPath, extension) : requestedPath;
    assertPathAllowed(destPath);

    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(destPath, bytes);
    console.info('[FsController:downloadFile] 下载完成，大小:', bytes.byteLength, 'path:', destPath, 'mime:', mimeType);
    return { success: true, size: bytes.byteLength, path: destPath, mimeType };
  }

  /**
   * 某些 CDN（典型如火山引擎 TOS 上 Doubao/Seedance 视频）会在 Content-Disposition 等
   * 响应头里夹带原始 UTF-8 中文字节，未走 RFC 5987 编码。Electron net 的 Headers 严格
   * 走 ByteString，会抛 `Cannot convert argument to a ByteString` —— 这种 host 整批
   * 都跑不通 fetch，直接走 Node http 模块更稳。
   */
  private static readonly FETCH_INCOMPATIBLE_HOSTS = [
    'tos-cn-beijing.volces.com',
    'ark-acg-cn-beijing.tos-cn-beijing.volces.com',
  ];

  private static shouldSkipFetchForHost(url: string): boolean {
    try {
      const host = new URL(url).host.toLowerCase();
      return FsController.FETCH_INCOMPATIBLE_HOSTS.some(h => host.endsWith(h));
    } catch {
      return false;
    }
  }

  private static async downloadWithFetch(url: string, requestedPath: string, headers?: Record<string, string>): Promise<{ success: true; size: number; path: string; mimeType?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const request = typeof electronNet?.fetch === 'function'
        ? electronNet.fetch.bind(electronNet) as typeof fetch
        : fetch.bind(globalThis);
      const response = await request(url, {
        method: 'GET',
        redirect: 'follow',
        headers: FsController.buildDownloadHeaders(headers),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`下载失败: HTTP ${response.status}`);
      }
      return FsController.writeResponseToFile(response, requestedPath);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`下载超时 (${DOWNLOAD_TIMEOUT_MS}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async readFile(args: { filePath: string; encoding?: BufferEncoding }) {
    assertPathAllowed(args.filePath);
    const content = await fs.promises.readFile(args.filePath, args.encoding || 'utf-8');
    return { content };
  }

  async readFileAsBase64(args: { filePath: string }) {
    assertPathAllowed(args.filePath);
    const buffer = await fs.promises.readFile(args.filePath);
    return { base64: buffer.toString('base64') };
  }

  async writeFile(args: { filePath: string; data: string; encoding?: BufferEncoding; binary?: boolean }) {
    assertPathAllowed(args.filePath);
    if (args.binary) {
      const buffer = Buffer.from(args.data, 'base64');
      await fs.promises.writeFile(args.filePath, buffer);
    } else {
      await fs.promises.writeFile(args.filePath, args.data, args.encoding || 'utf-8');
    }
    return { success: true };
  }

  // 从 URL 下载文件到本地（绕过 CORS）
  // 最大重定向次数
  private static readonly MAX_REDIRECTS = 5;

  async downloadFile(args: { url: string; destPath: string; headers?: Record<string, string>; channelId?: string }): Promise<{ success: boolean; size: number; path: string; mimeType?: string }> {
    assertPathAllowed(args.destPath);
    let currentUrl = args.url;
    const authHeaders = FsController.buildAuthHeaders({ headers: args.headers, channelId: args.channelId });

    await validateUrl(currentUrl);
    if (FsController.shouldSkipFetchForHost(currentUrl)) {
      console.info('[FsController:downloadFile] host 在 fetch 不兼容名单，直接走 http.get:', currentUrl);
    } else {
      try {
        console.info('[FsController:downloadFile] fetch url:', currentUrl, 'timeout:', DOWNLOAD_TIMEOUT_MS, 'hasAuth:', Boolean(authHeaders.Authorization));
        return await FsController.downloadWithFetch(currentUrl, args.destPath, authHeaders);
      } catch (err: any) {
        console.warn('[FsController:downloadFile] fetch 下载失败，回退 http.get:', err?.message || err);
      }
    }

    for (let redirectCount = 0; redirectCount <= FsController.MAX_REDIRECTS; redirectCount++) {
      // SSRF 防护：每次请求（含重定向）都校验 URL
      await validateUrl(currentUrl);

      console.info('[FsController:downloadFile] url:', currentUrl, 'redirect:', redirectCount);

      const result = await new Promise<
        | { redirect: string }
        | { success: true; size: number; path: string; mimeType?: string }
      >((resolve, reject) => {
        const protocol = currentUrl.startsWith('https') ? https : http;

        const request = protocol.get(currentUrl, { headers: FsController.buildDownloadHeaders(authHeaders), timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
            const redirectUrl = response.headers.location;
            response.resume(); // drain response
            if (redirectUrl) {
              // 处理相对路径重定向
              const resolved = new URL(redirectUrl, currentUrl).href;
              resolve({ redirect: resolved });
              return;
            }
            reject(new Error('重定向缺少 Location 头'));
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`下载失败: HTTP ${response.statusCode}`));
            return;
          }

          const mimeType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || undefined;
          const extension = FsController.getExtensionFromContentType(response.headers['content-type']);
          const destPath = extension ? FsController.replaceExtension(args.destPath, extension) : args.destPath;
          assertPathAllowed(destPath);

          const fileStream = fs.createWriteStream(destPath);
          let downloadedSize = 0;

          response.on('data', (chunk: Buffer) => {
            downloadedSize += chunk.length;
          });

          response.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            console.info('[FsController:downloadFile] 下载完成，大小:', downloadedSize, 'path:', destPath, 'mime:', mimeType);
            resolve({ success: true, size: downloadedSize, path: destPath, mimeType });
          });

          fileStream.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        }).on('timeout', () => {
          request.destroy(new Error(`下载超时 (${DOWNLOAD_TIMEOUT_MS}ms)`));
        }).on('error', (err) => {
          reject(err);
        });
      });

      if ('redirect' in result) {
        currentUrl = result.redirect;
        continue;
      }

      return result;
    }

    throw new Error(`重定向次数超过上限 (${FsController.MAX_REDIRECTS})`);
  }

  async exists(args: { filePath: string }) {
    assertPathAllowed(args.filePath);
    try {
      await fs.promises.access(args.filePath);
      return { exists: true };
    } catch {
      return { exists: false };
    }
  }

  async mkdir(args: { dirPath: string; recursive?: boolean }) {
    assertPathAllowed(args.dirPath);
    await fs.promises.mkdir(args.dirPath, { recursive: args.recursive ?? true });
    return { success: true };
  }

  async readdir(args: { dirPath: string }) {
    assertPathAllowed(args.dirPath);
    const files = await fs.promises.readdir(args.dirPath);
    return { files };
  }

  async stat(args: { filePath: string }) {
    assertPathAllowed(args.filePath);
    try {
      const stats = await fs.promises.stat(args.filePath);
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        createdAt: stats.birthtimeMs,
        modifiedAt: stats.mtimeMs,
      };
    } catch (err: unknown) {
      // 与 frontend 调用方约定一致：文件不存在 / 悬挂符号链接 / 权限受限等"正常缺失"
      // 类错误返回 null（所有调用点已用 `if (!stat)` 或 `stat?.` 适配）。
      // 这样 ee-core 的 ipcMain.handle 不会再把这些"非异常"打成 error 日志。
      // 典型场景：扫描 userData 目录时遇到 Chromium 创建的 SingletonLock 悬挂符号链接。
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') {
        return null;
      }
      throw err;
    }
  }

  async remove(args: { filePath: string; recursive?: boolean }) {
    assertPathAllowed(args.filePath);
    await fs.promises.rm(args.filePath, { recursive: args.recursive ?? true, force: true });
    return { success: true };
  }

  async copy(args: { src: string; dest: string }) {
    assertPathAllowed(args.src);
    assertPathAllowed(args.dest);
    await fs.promises.copyFile(args.src, args.dest);
    return { success: true };
  }
}

export = FsController;
