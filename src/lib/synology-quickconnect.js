function normalizePath(pathname) {
  const raw = String(pathname || "/").trim();
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const compact = prefixed.replace(/\/+/g, "/").replace(/\/$/, "");
  return compact || "/";
}

function basename(pathname) {
  return normalizePath(pathname).split("/").filter(Boolean).at(-1) || "";
}

function joinPath(...parts) {
  const merged = parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("/");
  return normalizePath(merged);
}

function extractBaseUrl(fullUrl) {
  const parsed = new URL(fullUrl);
  const marker = "/webapi/";
  const markerIndex = parsed.pathname.indexOf(marker);
  const basePath =
    markerIndex >= 0 ? parsed.pathname.slice(0, markerIndex) : "";
  return `${parsed.origin}${basePath}`;
}

function asQuickConnectBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname.endsWith("quickconnect.to")) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function extractHostsFromText(text) {
  const hosts = new Set();
  const source = String(text || "");

  for (const match of source.matchAll(
    /([a-z0-9-]+(?:\.[a-z0-9-]+)*\.quickconnect\.to)/gi,
  )) {
    const host = String(match[1] || "").toLowerCase();
    if (host && host !== "quickconnect.to") {
      hosts.add(host);
    }
  }

  return [...hosts];
}

function parseQuickConnectInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return { id: "", seeds: [] };

  const seeds = new Set();
  const addSeed = (candidate) => {
    const normalized = asQuickConnectBaseUrl(candidate);
    if (normalized) seeds.add(normalized);
  };

  addSeed(raw);
  const quickConnectPathMatch = raw.match(/quickconnect\.to\/([^/?#]+)/i);

  let id = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.hostname === "quickconnect.to") {
        const pathId = parsed.pathname.split("/").filter(Boolean)[0];
        if (pathId) id = pathId;
      } else if (parsed.hostname.endsWith(".quickconnect.to")) {
        id = parsed.hostname.split(".")[0] || id;
      }
    } catch {
      // Keep fallback id.
    }
  } else if (quickConnectPathMatch?.[1]) {
    id = quickConnectPathMatch[1];
  } else if (/\.quickconnect\.to$/i.test(raw)) {
    id = raw.split(".")[0] || raw;
  }

  id = String(id || "").trim();
  return { id, seeds: [...seeds] };
}

async function discoverQuickConnectCandidates(id, baseCandidates = []) {
  const candidates = new Set();
  const probes = new Set(baseCandidates.filter(Boolean));

  if (id) {
    probes.add(`https://${id}.quickconnect.to`);
    probes.add(`https://quickconnect.to/${encodeURIComponent(id)}`);
  }

  for (const probeUrl of probes) {
    try {
      const response = await requestJson(probeUrl, { timeoutMs: 9000 });
      const baseFromUrl = asQuickConnectBaseUrl(response.url);
      if (baseFromUrl) candidates.add(baseFromUrl);

      const hosts = extractHostsFromText(response.text);
      for (const host of hosts) {
        candidates.add(`https://${host}`);
      }
    } catch {
      // Best-effort discovery. Ignore failed probes.
    }
  }

  return [...candidates];
}

async function requestJson(
  url,
  { method = "GET", bodyParams, timeoutMs = 12000 } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers:
        method === "POST"
          ? {
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            }
          : undefined,
      body: method === "POST" && bodyParams ? bodyParams.toString() : undefined,
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      text,
      json,
    };
  } finally {
    clearTimeout(timer);
  }
}

function authErrorDetails(code) {
  if (code === 400)
    return {
      type: "invalid_credentials",
      message: "Invalid account or password.",
    };
  if (code === 401)
    return { type: "account_disabled", message: "Account disabled." };
  if (code === 402)
    return { type: "permission_denied", message: "Permission denied." };
  if (code === 403)
    return { type: "otp_required", message: "2FA code is required." };
  if (code === 404)
    return { type: "otp_invalid", message: "2FA code is invalid." };
  return {
    type: "auth_failed",
    message: `Authentication failed with DSM code ${code}.`,
  };
}

async function probeCandidate(baseUrl) {
  const queryUrl = `${baseUrl}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth`;
  const result = await requestJson(queryUrl);

  if (!result.json || !result.json.success) {
    throw new Error("Query API did not return DSM JSON response.");
  }

  return {
    baseUrl: extractBaseUrl(result.url || queryUrl),
    queryResult: result.json,
  };
}

export async function resolveQuickConnectBaseUrl(quickConnectId) {
  const parsed = parseQuickConnectInput(quickConnectId);
  if (!parsed.id) {
    throw new Error("QuickConnect ID is required.");
  }

  const orderedCandidates = [];
  const seen = new Set();
  const pushCandidate = (candidate) => {
    const normalized = asQuickConnectBaseUrl(candidate) || candidate;
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    orderedCandidates.push(normalized);
  };

  for (const seed of parsed.seeds) {
    pushCandidate(seed);
  }

  pushCandidate(`https://${parsed.id}.quickconnect.to`);
  pushCandidate(`https://${parsed.id}.tw6.quickconnect.to`);
  pushCandidate(`https://quickconnect.to/${encodeURIComponent(parsed.id)}`);

  const discovered = await discoverQuickConnectCandidates(
    parsed.id,
    orderedCandidates,
  );
  for (const candidate of discovered) {
    pushCandidate(candidate);
  }

  const errors = [];

  for (const candidate of orderedCandidates) {
    try {
      const resolved = await probeCandidate(candidate);
      return {
        quickConnectId: parsed.id,
        candidate,
        baseUrl: resolved.baseUrl,
      };
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(
    `Cannot resolve QuickConnect endpoint. ${errors.join(" | ")}`,
  );
}

export async function quickConnectLogin({
  quickConnectId,
  username,
  password,
  otpCode,
}) {
  const resolved = await resolveQuickConnectBaseUrl(quickConnectId);

  const params = new URLSearchParams({
    api: "SYNO.API.Auth",
    version: "7",
    method: "login",
    account: String(username || ""),
    passwd: String(password || ""),
    session: "FileStation",
    format: "sid",
  });

  if (String(otpCode || "").trim()) {
    params.set("otp_code", String(otpCode).trim());
  }

  const authUrl = `${resolved.baseUrl}/webapi/auth.cgi`;
  const authResult = await requestJson(authUrl, {
    method: "POST",
    bodyParams: params,
  });

  if (!authResult.json) {
    throw new Error("QuickConnect endpoint did not return DSM auth JSON.");
  }

  if (!authResult.json.success) {
    const code = Number(authResult.json.error?.code || 0);
    const details = authErrorDetails(code);
    return {
      ok: false,
      requiresOtp: details.type === "otp_required",
      otpInvalid: details.type === "otp_invalid",
      errorCode: code,
      message: details.message,
      resolved,
    };
  }

  const sid = authResult.json.data?.sid;
  if (!sid) {
    throw new Error("DSM auth succeeded but SID is missing.");
  }

  return {
    ok: true,
    resolved,
    sid,
  };
}

async function fileStationRequest({
  baseUrl,
  sid,
  api,
  version,
  method,
  extra = {},
}) {
  const params = new URLSearchParams({
    api,
    version: String(version),
    method,
    _sid: sid,
    ...extra,
  });

  const url = `${baseUrl}/webapi/entry.cgi?${params.toString()}`;
  const result = await requestJson(url);

  if (!result.json) {
    throw new Error("FileStation endpoint did not return JSON.");
  }

  if (!result.json.success) {
    const code = Number(result.json.error?.code || 0);
    throw new Error(`FileStation request failed with DSM code ${code}.`);
  }

  return result.json;
}

async function fileStationRawRequest({
  baseUrl,
  sid,
  api,
  version,
  method,
  extra = {},
}) {
  const params = new URLSearchParams({
    api,
    version: String(version),
    method,
    _sid: sid,
    ...extra,
  });

  const url = `${baseUrl}/webapi/entry.cgi?${params.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    redirect: "follow",
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `FileStation raw request failed (${response.status}). ${details || "No details"}`,
    );
  }

  return response;
}

function isImageName(name) {
  return /\.(jpg|jpeg|png|webp|gif|bmp|tif|tiff|heic|heif|avif)$/i.test(
    String(name || ""),
  );
}

function normalizeImageEntry(entry, parentPath) {
  const itemPath = normalizePath(
    entry?.path || joinPath(parentPath, entry?.name),
  );
  const name = String(entry?.name || basename(itemPath)).trim();
  if (!name || !isImageName(name)) return null;

  return {
    name,
    path: itemPath,
    size: Number(entry?.additional?.size || 0),
    modifiedTime: Number(entry?.additional?.time?.mtime || 0),
  };
}

export async function quickConnectListFolders({ baseUrl, sid, path }) {
  const normalizedPath = normalizePath(path || "/");
  let folders = [];

  if (normalizedPath === "/") {
    try {
      const sharesJson = await fileStationRequest({
        baseUrl,
        sid,
        api: "SYNO.FileStation.List",
        version: 2,
        method: "list_share",
        extra: {
          additional: "real_path",
        },
      });

      const shares = Array.isArray(sharesJson.data?.shares)
        ? sharesJson.data.shares
        : [];

      folders = shares
        .map((share) => {
          const shareName = String(share?.name || "").trim();
          const sharePath = normalizePath(share?.path || `/${shareName}`);
          return {
            name: shareName || sharePath.split("/").filter(Boolean).at(-1),
            path: sharePath,
          };
        })
        .filter((item) => Boolean(item.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // Fall back to standard list below for DSM variants that do not expose list_share.
    }
  }

  if (folders.length === 0) {
    const json = await fileStationRequest({
      baseUrl,
      sid,
      api: "SYNO.FileStation.List",
      version: 2,
      method: "list",
      extra: {
        folder_path: normalizedPath,
        additional: "real_path",
      },
    });

    const files = Array.isArray(json.data?.files) ? json.data.files : [];
    folders = files
      .filter((item) => item?.isdir)
      .map((item) => ({
        name: item.name,
        path: normalizePath(item.path || joinPath(normalizedPath, item.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    ok: true,
    path: normalizedPath,
    folders,
  };
}

export async function quickConnectListEntries({ baseUrl, sid, path }) {
  const normalizedPath = normalizePath(path || "/");
  let folders = [];
  let files = [];

  if (normalizedPath === "/") {
    try {
      const sharesJson = await fileStationRequest({
        baseUrl,
        sid,
        api: "SYNO.FileStation.List",
        version: 2,
        method: "list_share",
        extra: {
          additional: "real_path",
        },
      });

      const shares = Array.isArray(sharesJson.data?.shares)
        ? sharesJson.data.shares
        : [];

      folders = shares
        .map((share) => {
          const shareName = String(share?.name || "").trim();
          const sharePath = normalizePath(share?.path || `/${shareName}`);
          return {
            name: shareName || basename(sharePath),
            path: sharePath,
          };
        })
        .filter((item) => Boolean(item.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // Fall back to standard list below for DSM variants that do not expose list_share.
    }
  }

  if (folders.length === 0 || normalizedPath !== "/") {
    const json = await fileStationRequest({
      baseUrl,
      sid,
      api: "SYNO.FileStation.List",
      version: 2,
      method: "list",
      extra: {
        folder_path: normalizedPath,
        additional: "real_path,size,time",
      },
    });

    const entries = Array.isArray(json.data?.files) ? json.data.files : [];

    folders = entries
      .filter((item) => item?.isdir)
      .map((item) => ({
        name: item.name,
        path: normalizePath(item.path || joinPath(normalizedPath, item.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    files = entries
      .filter((item) => !item?.isdir)
      .map((item) => normalizeImageEntry(item, normalizedPath))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    ok: true,
    path: normalizedPath,
    folders,
    files,
  };
}

function parseContentDispositionFileName(value, fallbackPath) {
  const header = String(value || "");
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }

  const plain = header.match(/filename="?([^";]+)"?/i);
  if (plain?.[1]) return plain[1];

  return basename(fallbackPath) || "image";
}

export async function quickConnectReadFile({ baseUrl, sid, path }) {
  const result = await quickConnectReadFileStream({ baseUrl, sid, path });

  if (!result.body) {
    throw new Error("File stream is empty.");
  }

  const buffered = await new Response(result.body).arrayBuffer();

  return {
    ok: true,
    arrayBuffer: buffered,
    contentType: result.contentType,
    fileName: result.fileName,
  };
}

export async function quickConnectReadFileStream({ baseUrl, sid, path }) {
  const normalizedPath = normalizePath(path || "/");

  const response = await fileStationRawRequest({
    baseUrl,
    sid,
    api: "SYNO.FileStation.Download",
    version: 2,
    method: "download",
    extra: {
      path: JSON.stringify([normalizedPath]),
      mode: "open",
    },
  });

  return {
    ok: true,
    body: response.body,
    contentType:
      response.headers.get("content-type") || "application/octet-stream",
    fileName: parseContentDispositionFileName(
      response.headers.get("content-disposition"),
      normalizedPath,
    ),
    contentLength: response.headers.get("content-length"),
  };
}

export async function quickConnectReadThumbnail({
  baseUrl,
  sid,
  path,
  size = "small",
}) {
  const normalizedPath = normalizePath(path || "/");
  const allowedSize = ["small", "medium", "large"].includes(size)
    ? size
    : "small";

  try {
    const response = await fileStationRawRequest({
      baseUrl,
      sid,
      api: "SYNO.FileStation.Thumb",
      version: 2,
      method: "get",
      extra: {
        path: JSON.stringify([normalizedPath]),
        size: allowedSize,
      },
    });

    return {
      ok: true,
      arrayBuffer: await response.arrayBuffer(),
      contentType:
        response.headers.get("content-type") || "application/octet-stream",
      fileName: parseContentDispositionFileName(
        response.headers.get("content-disposition"),
        normalizedPath,
      ),
      source: "thumb",
    };
  } catch {
    const fallback = await quickConnectReadFile({
      baseUrl,
      sid,
      path: normalizedPath,
    });

    return {
      ...fallback,
      source: "download",
    };
  }
}

export async function quickConnectMirrorCreate({
  baseUrl,
  sid,
  leftRoot,
  rightRoot,
  parentRelative,
  folderName,
}) {
  const name = String(folderName || "").trim();
  if (!name) {
    throw new Error("Folder name is required.");
  }
  if (/[\\/]/.test(name) || name === "." || name === "..") {
    throw new Error("Folder name contains invalid characters.");
  }

  const relative = normalizePath(parentRelative || "/");
  const leftParent = joinPath(leftRoot || "/", relative);
  const rightParent = joinPath(rightRoot || "/", relative);

  const createAt = async (parentPath) => {
    try {
      await fileStationRequest({
        baseUrl,
        sid,
        api: "SYNO.FileStation.CreateFolder",
        version: 2,
        method: "create",
        extra: {
          folder_path: parentPath,
          name,
          force_parent: "false",
        },
      });

      return {
        path: joinPath(parentPath, name),
        ok: true,
        result: "created",
      };
    } catch (error) {
      const exists = /code\s*408|code\s*414|exist/i.test(
        String(error?.message || ""),
      );
      if (exists) {
        return {
          path: joinPath(parentPath, name),
          ok: true,
          result: "exists",
        };
      }
      return {
        path: joinPath(parentPath, name),
        ok: false,
        result: "failed",
        details: String(error?.message || "CreateFolder failed."),
      };
    }
  };

  const [left, right] = await Promise.all([
    createAt(leftParent),
    createAt(rightParent),
  ]);

  if (!left.ok || !right.ok) {
    throw new Error(
      `Mirror create failed. Left(${left.result}), Right(${right.result}). ${left.details || ""} ${right.details || ""}`,
    );
  }

  return {
    ok: true,
    left,
    right,
  };
}

export async function quickConnectDiagnostics({
  quickConnectId,
  username,
  password,
  otpCode,
}) {
  const checks = [];

  try {
    const resolved = await resolveQuickConnectBaseUrl(quickConnectId);
    checks.push({
      key: "resolve",
      label: "Resolve QuickConnect",
      ok: true,
      details: `Resolved to ${resolved.baseUrl}`,
    });

    if (username && password) {
      const login = await quickConnectLogin({
        quickConnectId,
        username,
        password,
        otpCode,
      });
      if (login.ok) {
        checks.push({
          key: "login",
          label: "DSM login",
          ok: true,
          details: "Authenticated successfully via SYNO.API.Auth.",
        });
      } else {
        checks.push({
          key: "login",
          label: "DSM login",
          ok: false,
          details: login.message,
        });
      }
    } else {
      checks.push({
        key: "login",
        label: "DSM login",
        ok: false,
        details: "Skipped: username/password not provided.",
      });
    }
  } catch (error) {
    checks.push({
      key: "resolve",
      label: "Resolve QuickConnect",
      ok: false,
      details: String(error?.message || "Resolve failed."),
    });
  }

  return {
    ok: checks.every((item) => item.ok),
    checks,
    ranAt: new Date().toISOString(),
  };
}
