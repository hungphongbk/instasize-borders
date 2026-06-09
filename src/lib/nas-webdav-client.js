function normalizePath(pathname) {
  const raw = String(pathname || "/").trim();
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const compact = prefixed.replace(/\/+/g, "/").replace(/\/$/, "");
  return compact || "/";
}

const IPV4_PART = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_REGEX = new RegExp(
  `^${IPV4_PART}\\.${IPV4_PART}\\.${IPV4_PART}\\.${IPV4_PART}$`,
);

function isPrivateIpv4(host) {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  return false;
}

export function isLanHost(host) {
  const lower = String(host || "")
    .trim()
    .toLowerCase();
  if (!lower) return false;
  if (lower === "localhost") return true;
  if (lower.endsWith(".local")) return true;

  if (lower.includes(":")) {
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd");
  }

  if (!IPV4_REGEX.test(lower)) return false;
  return isPrivateIpv4(lower);
}

function joinPath(...parts) {
  const merged = parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("/");
  return normalizePath(merged);
}

function encodePath(pathname) {
  return normalizePath(pathname)
    .split("/")
    .map((segment, index) => {
      if (index === 0) return "";
      return encodeURIComponent(segment);
    })
    .join("/");
}

function buildBaseUrl(connection) {
  const protocol = connection.protocol === "http" ? "http" : "https";
  const host = String(connection.host || "").trim();
  const port = String(connection.port || "").trim();
  if (!host) {
    throw new Error("Host is required.");
  }
  return `${protocol}://${host}${port ? `:${port}` : ""}`;
}

function toBase64(value) {
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    return window.btoa(unescape(encodeURIComponent(value)));
  }
  throw new Error("Base64 encoder is unavailable in this browser.");
}

function authHeader(connection) {
  const user = String(connection.username || "");
  const pass = String(connection.password || "");
  return `Basic ${toBase64(`${user}:${pass}`)}`;
}

function buildRequestUrl(connection, targetPath) {
  const baseUrl = buildBaseUrl(connection);
  const rootPath = normalizePath(connection.webdavRoot || "/");
  const fullPath = joinPath(rootPath, targetPath || "/");
  return {
    url: `${baseUrl}${encodePath(fullPath)}`,
    requestPath: fullPath,
  };
}

function parseFolderChildren(xml, requestPath) {
  const blockRegex = /<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi;
  const hrefRegex = /<(?:\w+:)?href\b[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i;
  const requestWithSlash = `${normalizePath(requestPath)}/`;

  const folders = [];
  const unique = new Set();

  for (const block of String(xml || "").match(blockRegex) || []) {
    if (!/(?:\w+:)?collection\b/i.test(block)) continue;

    const hrefMatch = block.match(hrefRegex);
    if (!hrefMatch?.[1]) continue;

    const rawHref = hrefMatch[1].trim();
    let pathname = rawHref;

    try {
      pathname = new URL(rawHref).pathname;
    } catch {
      pathname = rawHref;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      decodedPath = pathname;
    }

    const normalizedHrefPath = normalizePath(decodedPath);
    const hrefWithSlash = `${normalizedHrefPath}/`;

    if (hrefWithSlash === requestWithSlash) continue;
    if (!hrefWithSlash.startsWith(requestWithSlash)) continue;

    const remainder = hrefWithSlash.slice(requestWithSlash.length);
    const firstSegment = remainder.split("/").filter(Boolean)[0];
    if (!firstSegment || unique.has(firstSegment)) continue;

    unique.add(firstSegment);
    folders.push({
      name: firstSegment,
      path: joinPath(requestPath, firstSegment),
    });
  }

  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

function mapWebdavStatus(status) {
  if (status === 201) return "created";
  if (status === 405) return "exists";
  if (status >= 200 && status < 300) return "ok";
  return "failed";
}

function mkcolResult(path, response, details) {
  return {
    path,
    status: response.status,
    result: mapWebdavStatus(response.status),
    ok: response.ok || response.status === 405,
    details,
  };
}

export function normalizeNasPath(pathname) {
  return normalizePath(pathname);
}

export function explainDirectError(error) {
  const message = String(error?.message || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return "Direct LAN request failed before response. Check HTTPS certificate, CORS headers, browser LAN permission prompt, and whether NAS WebDAV is reachable from this device.";
  }
  return message || "Direct LAN request failed.";
}

export async function directWebdavRequest(
  connection,
  method,
  targetPath,
  options = {},
) {
  const { url, requestPath } = buildRequestUrl(connection, targetPath);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(connection),
        ...(options.headers || {}),
      },
      body: options.body,
      mode: "cors",
      cache: "no-store",
    });
  } catch (error) {
    throw new Error(explainDirectError(error));
  }

  return {
    response,
    requestPath,
  };
}

export async function directProbeConnection(connection, probePath = "/") {
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype />
  </d:prop>
</d:propfind>`;

  const { response, requestPath } = await directWebdavRequest(
    connection,
    "PROPFIND",
    normalizePath(probePath),
    {
      headers: {
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body,
    },
  );

  if (!response.ok && response.status !== 207) {
    const details = await response.text();
    throw new Error(
      `NAS rejected connection (${response.status}): ${details || "Unknown error"}`,
    );
  }

  return {
    ok: true,
    requestPath,
    status: response.status,
  };
}

export async function directListFolders(connection, path) {
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
  </d:prop>
</d:propfind>`;

  const normalizedPath = normalizePath(path || "/");
  const { response, requestPath } = await directWebdavRequest(
    connection,
    "PROPFIND",
    normalizedPath,
    {
      headers: {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body,
    },
  );

  if (!response.ok && response.status !== 207) {
    const details = await response.text();
    throw new Error(
      `Cannot load folder tree (${response.status}): ${details || "Unknown error"}`,
    );
  }

  const xml = await response.text();
  return {
    ok: true,
    path: normalizedPath,
    requestPath,
    folders: parseFolderChildren(xml, requestPath),
  };
}

export async function directMirrorCreate(
  connection,
  leftRoot,
  rightRoot,
  parentRelative,
  folderName,
) {
  const name = String(folderName || "").trim();
  if (!name) {
    throw new Error("Folder name is required.");
  }
  if (/[\\/]/.test(name) || name === "." || name === "..") {
    throw new Error("Folder name contains invalid characters.");
  }

  const relative = normalizePath(parentRelative || "/");
  const leftTarget = joinPath(leftRoot || "/", relative, name);
  const rightTarget = joinPath(rightRoot || "/", relative, name);

  const [leftRsp, rightRsp] = await Promise.all([
    directWebdavRequest(connection, "MKCOL", leftTarget),
    directWebdavRequest(connection, "MKCOL", rightTarget),
  ]);

  const leftDetails = leftRsp.response.ok ? "" : await leftRsp.response.text();
  const rightDetails = rightRsp.response.ok
    ? ""
    : await rightRsp.response.text();

  const left = mkcolResult(leftTarget, leftRsp.response, leftDetails);
  const right = mkcolResult(rightTarget, rightRsp.response, rightDetails);

  if (!left.ok || !right.ok) {
    throw new Error(
      `Mirror create failed. Left(${left.status} ${left.result}), Right(${right.status} ${right.result}).`,
    );
  }

  return {
    ok: true,
    left,
    right,
  };
}

export async function runDirectDiagnostics(connection) {
  const checks = [];
  const mode = connection.mode === "remote" ? "remote" : "lan";
  const secureContext =
    typeof window !== "undefined" ? Boolean(window.isSecureContext) : false;
  const origin =
    typeof window !== "undefined" ? window.location.origin : "unknown";

  checks.push({
    key: "secure-context",
    label: "Secure context",
    ok: secureContext,
    details: secureContext
      ? `Origin ${origin} is secure.`
      : `Origin ${origin} is not secure. Direct LAN typically requires HTTPS or localhost.`,
  });

  const { url } = buildRequestUrl(connection, "/");
  const targetHost = String(connection.host || "").trim();
  const targetProtocol = connection.protocol === "http" ? "http" : "https";

  if (mode === "lan") {
    const lan = isLanHost(targetHost);
    checks.push({
      key: "lan-host-check",
      label: "LAN host format",
      ok: lan,
      details: lan
        ? `Host ${targetHost} looks like LAN/private network.`
        : `Host ${targetHost} is not LAN/private. Switch to Internet mode if this is expected.`,
    });
  }

  if (mode === "remote") {
    const lan = isLanHost(targetHost);
    checks.push({
      key: "internet-host-check",
      label: "Internet host format",
      ok: !lan,
      details: !lan
        ? `Host ${targetHost} looks like public Internet endpoint.`
        : `Host ${targetHost} looks LAN/private. Internet mode usually expects public domain/IP.`,
    });
  }

  const mixedContentBlocked =
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    targetProtocol === "http";
  checks.push({
    key: "mixed-content",
    label: "Mixed content",
    ok: !mixedContentBlocked,
    details: mixedContentBlocked
      ? "Page is HTTPS but NAS endpoint is HTTP. Browser will likely block requests."
      : "No obvious mixed-content conflict detected.",
  });

  try {
    const optionsRsp = await fetch(url, {
      method: "OPTIONS",
      mode: "cors",
      cache: "no-store",
      headers: {
        Authorization: authHeader(connection),
      },
    });

    checks.push({
      key: "options",
      label: "CORS preflight/OPTIONS",
      ok:
        optionsRsp.ok || optionsRsp.status === 204 || optionsRsp.status === 405,
      details: `OPTIONS status ${optionsRsp.status}`,
    });
  } catch (error) {
    checks.push({
      key: "options",
      label: "CORS preflight/OPTIONS",
      ok: false,
      details: explainDirectError(error),
    });
  }

  try {
    const probe = await directProbeConnection(connection);
    checks.push({
      key: "propfind-depth0",
      label: "PROPFIND depth=0",
      ok: true,
      details: `PROPFIND succeeded (status ${probe.status}).`,
    });
  } catch (error) {
    checks.push({
      key: "propfind-depth0",
      label: "PROPFIND depth=0",
      ok: false,
      details: explainDirectError(error),
    });
  }

  try {
    const tree = await directListFolders(connection, "/");
    checks.push({
      key: "propfind-depth1",
      label: "PROPFIND depth=1",
      ok: true,
      details: `Loaded ${tree.folders.length} folders under ${tree.path}.`,
    });
  } catch (error) {
    checks.push({
      key: "propfind-depth1",
      label: "PROPFIND depth=1",
      ok: false,
      details: explainDirectError(error),
    });
  }

  return {
    ok: checks.every((item) => item.ok),
    checks,
    ranAt: new Date().toISOString(),
  };
}
