"use client";

import {
  directListFolders,
  directMirrorCreate,
  directProbeConnection,
  explainDirectError,
  isLanHost,
  runDirectDiagnostics,
} from "@/lib/nas-webdav-client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "nas-sync-connection";
const ROOTS_KEY = "nas-sync-roots";

const DEFAULT_CONNECTION = {
  mode: "lan",
  protocol: "https",
  host: "",
  port: "5006",
  username: "",
  password: "",
  webdavRoot: "/",
  rememberCredentials: false,
};

function normalizeConnectionMode(value) {
  return value === "remote" ? "remote" : "lan";
}

function normalizePath(pathname) {
  const raw = String(pathname || "/").trim();
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const collapsed = prefixed.replace(/\/+/g, "/").replace(/\/$/, "");
  return collapsed || "/";
}

function rootTree(pathname) {
  const path = normalizePath(pathname);
  return {
    rootPath: path,
    nodes: {
      [path]: {
        path,
        name: path === "/" ? "/" : path.split("/").filter(Boolean).at(-1),
        children: [],
        loaded: false,
        expanded: false,
        isLoading: false,
        error: "",
      },
    },
  };
}

function relativeFromRoot(rootPath, nodePath) {
  const root = normalizePath(rootPath);
  const node = normalizePath(nodePath);
  if (root === "/") return node;
  if (node === root) return "/";
  if (node.startsWith(`${root}/`)) {
    return node.slice(root.length) || "/";
  }
  return "/";
}

function prettyConnection(connection) {
  const protocol = connection.protocol === "http" ? "http" : "https";
  return `${protocol}://${connection.host}${connection.port ? `:${connection.port}` : ""}`;
}

function FolderTree({ side, tree, onToggle, onCreate }) {
  const renderNode = (path, depth) => {
    const node = tree.nodes[path];
    if (!node) return null;
    return (
      <li key={`${side}_${path}`} className="space-y-2">
        <div
          className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white/80 px-2 py-1.5"
          style={{ marginLeft: `${depth * 14}px` }}
        >
          <button
            type="button"
            onClick={() => onToggle(side, path)}
            className="h-7 w-7 shrink-0 rounded-lg border border-slate-300 text-slate-700"
            aria-label={node.expanded ? "Thu gọn" : "Mở rộng"}
            disabled={node.isLoading}
          >
            {node.expanded ? "-" : "+"}
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
            {node.path === tree.rootPath ? node.path : node.name}
          </span>
          <button
            type="button"
            onClick={() => onCreate(side, path)}
            className="rounded-lg bg-slate-900 px-2 py-1 text-xs font-medium text-white"
          >
            New
          </button>
        </div>

        {node.error ? (
          <p
            className="text-xs text-red-600"
            style={{ marginLeft: `${depth * 14 + 34}px` }}
          >
            {node.error}
          </p>
        ) : null}

        {node.isLoading ? (
          <p
            className="text-xs text-slate-500"
            style={{ marginLeft: `${depth * 14 + 34}px` }}
          >
            Loading...
          </p>
        ) : null}

        {node.expanded && node.children.length > 0 ? (
          <ul className="space-y-2">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}

        {node.expanded &&
        node.loaded &&
        node.children.length === 0 &&
        !node.isLoading ? (
          <p
            className="text-xs text-slate-500"
            style={{ marginLeft: `${depth * 14 + 34}px` }}
          >
            No sub-folders
          </p>
        ) : null}
      </li>
    );
  };

  return <ul className="space-y-2">{renderNode(tree.rootPath, 0)}</ul>;
}

export default function NasSyncPage() {
  const [connectionDraft, setConnectionDraft] = useState(DEFAULT_CONNECTION);
  const [connection, setConnection] = useState(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const [leftTree, setLeftTree] = useState(rootTree("/"));
  const [rightTree, setRightTree] = useState(rootTree("/"));

  const [picker, setPicker] = useState({
    open: false,
    side: "left",
    currentPath: "/",
    loading: false,
    error: "",
    folders: [],
  });
  const [diagnostics, setDiagnostics] = useState({
    running: false,
    result: null,
    error: "",
  });

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        setConnectionDraft((prev) => ({ ...prev, ...parsed }));
      }

      const savedRoots = localStorage.getItem(ROOTS_KEY);
      if (savedRoots) {
        const parsedRoots = JSON.parse(savedRoots);
        if (parsedRoots?.left) setLeftTree(rootTree(parsedRoots.left));
        if (parsedRoots?.right) setRightTree(rootTree(parsedRoots.right));
      }
    } catch {
      // Ignore invalid local storage data.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...connectionDraft,
          password: connectionDraft.rememberCredentials
            ? connectionDraft.password
            : "",
        }),
      );
    } catch {
      // Ignore storage errors.
    }
  }, [connectionDraft]);

  useEffect(() => {
    try {
      localStorage.setItem(
        ROOTS_KEY,
        JSON.stringify({
          left: leftTree.rootPath,
          right: rightTree.rootPath,
        }),
      );
    } catch {
      // Ignore storage errors.
    }
  }, [leftTree.rootPath, rightTree.rootPath]);

  const endpoint = useMemo(
    () =>
      connection
        ? prettyConnection(connection)
        : prettyConnection(connectionDraft),
    [connection, connectionDraft],
  );
  const connectionMode = normalizeConnectionMode(connectionDraft.mode);

  const updateTreeState = (side, updater) => {
    if (side === "left") {
      setLeftTree((prev) => updater(prev));
      return;
    }
    setRightTree((prev) => updater(prev));
  };

  const activeTree = (side) => (side === "left" ? leftTree : rightTree);

  const connectToNas = async () => {
    setBusy(true);
    setStatus("");

    try {
      const sanitized = {
        ...connectionDraft,
        mode: normalizeConnectionMode(connectionDraft.mode),
        host: String(connectionDraft.host || "").trim(),
        port: String(connectionDraft.port || "").trim(),
        username: String(connectionDraft.username || "").trim(),
        webdavRoot: normalizePath(connectionDraft.webdavRoot || "/"),
      };

      if (sanitized.mode === "lan" && !isLanHost(sanitized.host)) {
        throw new Error(
          "LAN mode requires private IP, localhost, or .local host. Use Internet mode for public domains.",
        );
      }

      if (
        typeof window !== "undefined" &&
        window.location.protocol === "https:" &&
        sanitized.protocol === "http"
      ) {
        throw new Error(
          "This app is running on HTTPS, but NAS endpoint is HTTP. Browser mixed-content policy may block requests. Use HTTPS on NAS endpoint.",
        );
      }

      await directProbeConnection(sanitized);

      setConnectionDraft(sanitized);
      setConnection(sanitized);
      setStatus("Connected to NAS successfully.");
      setDiagnostics({ running: false, result: null, error: "" });
    } catch (error) {
      setStatus(explainDirectError(error));
    } finally {
      setBusy(false);
    }
  };

  const requestLanPermission = async () => {
    setBusy(true);
    setStatus("");

    try {
      const draft = {
        ...connectionDraft,
        mode: normalizeConnectionMode(connectionDraft.mode),
        host: String(connectionDraft.host || "").trim(),
        port: String(connectionDraft.port || "").trim(),
        username: String(connectionDraft.username || "").trim(),
        webdavRoot: normalizePath(connectionDraft.webdavRoot || "/"),
      };

      if (draft.mode === "lan" && !isLanHost(draft.host)) {
        throw new Error(
          "LAN mode requires private IP, localhost, or .local host. Use Internet mode for public domains.",
        );
      }

      await directProbeConnection(draft);
      setStatus(
        "Direct LAN probe succeeded from main thread. Browser LAN permission for this origin should now be granted.",
      );
    } catch (error) {
      setStatus(explainDirectError(error));
    } finally {
      setBusy(false);
    }
  };

  const runDiagnostics = async () => {
    setDiagnostics({ running: true, result: null, error: "" });
    setStatus("");

    try {
      const draft = {
        ...connectionDraft,
        mode: normalizeConnectionMode(connectionDraft.mode),
        host: String(connectionDraft.host || "").trim(),
        port: String(connectionDraft.port || "").trim(),
        username: String(connectionDraft.username || "").trim(),
        webdavRoot: normalizePath(connectionDraft.webdavRoot || "/"),
      };

      const result = await runDirectDiagnostics(draft);
      setDiagnostics({ running: false, result, error: "" });
    } catch (error) {
      setDiagnostics({
        running: false,
        result: null,
        error: explainDirectError(error),
      });
    }
  };

  const loadChildren = async (side, path) => {
    if (!connection) return;

    updateTreeState(side, (prev) => ({
      ...prev,
      nodes: {
        ...prev.nodes,
        [path]: {
          ...prev.nodes[path],
          isLoading: true,
          error: "",
        },
      },
    }));

    try {
      const data = await directListFolders(connection, path);

      updateTreeState(side, (prev) => {
        const nextNodes = { ...prev.nodes };
        const node = nextNodes[path];
        if (!node) return prev;

        const children = [];
        for (const folder of data.folders || []) {
          const childPath = normalizePath(folder.path);
          children.push(childPath);

          if (!nextNodes[childPath]) {
            nextNodes[childPath] = {
              path: childPath,
              name: folder.name,
              children: [],
              loaded: false,
              expanded: false,
              isLoading: false,
              error: "",
            };
          }
        }

        nextNodes[path] = {
          ...node,
          children,
          loaded: true,
          isLoading: false,
          error: "",
        };

        return {
          ...prev,
          nodes: nextNodes,
        };
      });
    } catch (error) {
      const message = explainDirectError(error);
      updateTreeState(side, (prev) => ({
        ...prev,
        nodes: {
          ...prev.nodes,
          [path]: {
            ...prev.nodes[path],
            isLoading: false,
            error: message,
          },
        },
      }));
    }
  };

  const onToggleNode = async (side, path) => {
    const tree = activeTree(side);
    const node = tree.nodes[path];
    if (!node) return;

    updateTreeState(side, (prev) => ({
      ...prev,
      nodes: {
        ...prev.nodes,
        [path]: {
          ...prev.nodes[path],
          expanded: !prev.nodes[path].expanded,
        },
      },
    }));

    if (!node.loaded) {
      await loadChildren(side, path);
    }
  };

  const applyRootPath = async (side, value) => {
    const nextRoot = normalizePath(value);
    updateTreeState(side, () => rootTree(nextRoot));
    setStatus("");
  };

  const draftRootPath = (side, value) => {
    const nextRoot = normalizePath(value);
    updateTreeState(side, (prev) => ({
      ...prev,
      rootPath: nextRoot,
    }));
  };

  const refreshBothTrees = () => {
    setLeftTree((prev) => rootTree(prev.rootPath));
    setRightTree((prev) => rootTree(prev.rootPath));
  };

  const createFolderMirrored = async (sourceSide, nodePath) => {
    if (!connection) return;

    const folderName = window.prompt("New folder name");
    if (!folderName) return;

    const sourceTree = activeTree(sourceSide);
    const relative = relativeFromRoot(sourceTree.rootPath, nodePath);

    setBusy(true);
    setStatus("");

    try {
      const result = await directMirrorCreate(
        connection,
        leftTree.rootPath,
        rightTree.rootPath,
        relative,
        folderName,
      );

      const leftState = result.left?.result || "unknown";
      const rightState = result.right?.result || "unknown";
      setStatus(
        `Mirrored folder done. Left: ${leftState}, Right: ${rightState}.`,
      );
      refreshBothTrees();
    } catch (error) {
      setStatus(explainDirectError(error));
    } finally {
      setBusy(false);
    }
  };

  const loadPicker = async (side, path) => {
    if (!connection) return;

    setPicker((prev) => ({
      ...prev,
      open: true,
      side,
      currentPath: normalizePath(path),
      loading: true,
      error: "",
      folders: [],
    }));

    try {
      const data = await directListFolders(connection, normalizePath(path));

      setPicker((prev) => ({
        ...prev,
        loading: false,
        folders: data.folders || [],
      }));
    } catch (error) {
      const message = explainDirectError(error);
      setPicker((prev) => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  };

  const browseInto = (folderPath) => {
    loadPicker(picker.side, folderPath);
  };

  if (!connection) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,#e5f4ff_0%,#f8fbff_38%,#fdf7ef_100%)] px-5 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 rounded-3xl border border-black/10 bg-white/85 p-6 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.7)] sm:p-8">
          <header className="space-y-3">
            <Link
              href="/"
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              &larr; Back to home
            </Link>
            <p className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              NAS Mirror Sync
            </p>
            <h1 className="text-3xl font-semibold text-slate-900 sm:text-4xl">
              Connection Wizard
            </h1>
            <p className="text-sm text-slate-600 sm:text-base">
              This feature uses Synology WebDAV on DSM 7 and runs fully in your
              browser, supporting both LAN and Internet mode.
            </p>
          </header>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
              Mode
              <select
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={connectionMode}
                onChange={(event) =>
                  setConnectionDraft((prev) => ({
                    ...prev,
                    mode: normalizeConnectionMode(event.target.value),
                  }))
                }
              >
                <option value="lan">LAN only</option>
                <option value="remote">Internet</option>
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
              Protocol
              <select
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={connectionDraft.protocol}
                onChange={(event) =>
                  setConnectionDraft((prev) => ({
                    ...prev,
                    protocol: event.target.value,
                  }))
                }
              >
                <option value="https">https</option>
                <option value="http">http</option>
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700 sm:col-span-2">
              Host/IP
              <input
                type="text"
                placeholder="192.168.1.20"
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={connectionDraft.host}
                onChange={(event) =>
                  setConnectionDraft((prev) => ({
                    ...prev,
                    host: event.target.value,
                  }))
                }
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
              Port
              <input
                type="text"
                placeholder={
                  connectionDraft.protocol === "https" ? "5006" : "5005"
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={connectionDraft.port}
                onChange={(event) =>
                  setConnectionDraft((prev) => ({
                    ...prev,
                    port: event.target.value,
                  }))
                }
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
              WebDAV root
              <input
                type="text"
                placeholder="/"
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={connectionDraft.webdavRoot}
                onChange={(event) =>
                  setConnectionDraft((prev) => ({
                    ...prev,
                    webdavRoot: event.target.value,
                  }))
                }
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
              Username
              <input
                type="text"
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={connectionDraft.username}
                onChange={(event) =>
                  setConnectionDraft((prev) => ({
                    ...prev,
                    username: event.target.value,
                  }))
                }
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
              Password
              <input
                type="password"
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={connectionDraft.password}
                onChange={(event) =>
                  setConnectionDraft((prev) => ({
                    ...prev,
                    password: event.target.value,
                  }))
                }
              />
            </label>

            <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700 sm:col-span-2">
              <input
                type="checkbox"
                checked={Boolean(connectionDraft.rememberCredentials)}
                onChange={(event) =>
                  setConnectionDraft((prev) => ({
                    ...prev,
                    rememberCredentials: event.target.checked,
                  }))
                }
              />
              Remember credentials in localStorage on this browser
            </label>
          </section>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              onClick={connectToNas}
              disabled={busy}
            >
              {busy ? "Connecting..." : "Connect"}
            </button>
            {connectionMode === "lan" ? (
              <button
                type="button"
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
                onClick={requestLanPermission}
                disabled={busy}
              >
                Request LAN permission
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-60"
              onClick={runDiagnostics}
              disabled={busy || diagnostics.running}
            >
              {diagnostics.running
                ? "Running diagnostics..."
                : "Run diagnostics"}
            </button>
            <span className="text-sm text-slate-600">Endpoint: {endpoint}</span>
          </div>

          <p className="text-xs text-slate-500">
            {connectionMode === "lan"
              ? "LAN mode depends on LAN permission prompt, certificate trust, and NAS CORS support for PROPFIND/MKCOL."
              : "Internet mode depends on public endpoint reachability, TLS certificate trust, and NAS CORS support for PROPFIND/MKCOL."}
          </p>

          {diagnostics.error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {diagnostics.error}
            </p>
          ) : null}

          {diagnostics.result?.checks?.length ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <p className="mb-2 font-semibold">
                Diagnostics ({diagnostics.result.ok ? "PASS" : "CHECK REQUIRED"}
                )
              </p>
              <ul className="space-y-1">
                {diagnostics.result.checks.map((item) => (
                  <li key={item.key} className="rounded-lg bg-white px-2 py-1">
                    <span
                      className={item.ok ? "text-emerald-700" : "text-red-700"}
                    >
                      {item.ok ? "OK" : "FAIL"}
                    </span>{" "}
                    {item.label}: {item.details}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {status ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {status}
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#e5f4ff_0%,#f5fbff_40%,#f9f8f3_100%)] px-5 py-10">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <header className="rounded-3xl border border-black/10 bg-white/85 p-5 shadow-[0_24px_70px_-45px_rgba(15,23,42,0.8)] sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Link
                href="/"
                className="text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                &larr; Back to home
              </Link>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900">
                NAS Mirror Sync
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                Connected to {endpoint}. Create folder from either side and
                mirror creation will run on both roots.
              </p>
            </div>
            <button
              type="button"
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
              onClick={() => {
                setConnection(null);
                setStatus("");
              }}
            >
              Disconnect
            </button>
          </div>
          {status ? (
            <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {status}
            </p>
          ) : null}
        </header>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {[
            { side: "left", title: "Raw scan tree", tree: leftTree },
            {
              side: "right",
              title: "Exported JPEG/TIFF tree",
              tree: rightTree,
            },
          ].map((column) => (
            <article
              key={column.side}
              className="rounded-3xl border border-black/10 bg-white/85 p-4 shadow-[0_18px_60px_-42px_rgba(15,23,42,0.7)] sm:p-5"
            >
              <h2 className="text-lg font-semibold text-slate-900">
                {column.title}
              </h2>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  value={column.tree.rootPath}
                  onChange={(event) =>
                    draftRootPath(column.side, event.target.value)
                  }
                />
                <button
                  type="button"
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800"
                  onClick={() => loadPicker(column.side, column.tree.rootPath)}
                >
                  Folder picker
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
                  onClick={() =>
                    applyRootPath(column.side, column.tree.rootPath)
                  }
                >
                  Load tree
                </button>
              </div>

              <div className="mt-4 max-h-[55vh] overflow-auto rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
                <FolderTree
                  side={column.side}
                  tree={column.tree}
                  onToggle={onToggleNode}
                  onCreate={createFolderMirrored}
                />
              </div>
            </article>
          ))}
        </section>
      </div>

      {picker.open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
            <h3 className="text-lg font-semibold text-slate-900">
              Folder Picker ({picker.side})
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Current path: {picker.currentPath}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                onClick={() =>
                  browseInto(
                    picker.currentPath === "/"
                      ? "/"
                      : picker.currentPath.split("/").slice(0, -1).join("/") ||
                          "/",
                  )
                }
              >
                Go up
              </button>
              <button
                type="button"
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
                onClick={() => {
                  applyRootPath(picker.side, picker.currentPath);
                  setPicker((prev) => ({ ...prev, open: false }));
                }}
              >
                Select this folder
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                onClick={() => setPicker((prev) => ({ ...prev, open: false }))}
              >
                Close
              </button>
            </div>

            <div className="mt-4 max-h-[45vh] overflow-auto rounded-xl border border-slate-200 p-2">
              {picker.loading ? (
                <p className="p-2 text-sm text-slate-500">Loading...</p>
              ) : null}
              {picker.error ? (
                <p className="p-2 text-sm text-red-600">{picker.error}</p>
              ) : null}
              {!picker.loading &&
              !picker.error &&
              picker.folders.length === 0 ? (
                <p className="p-2 text-sm text-slate-500">
                  No sub-folders here.
                </p>
              ) : null}
              {!picker.loading && picker.folders.length > 0 ? (
                <ul className="space-y-1">
                  {picker.folders.map((folder) => (
                    <li key={folder.path}>
                      <button
                        type="button"
                        className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-100"
                        onClick={() => browseInto(folder.path)}
                      >
                        {folder.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {busy ? (
        <div className="fixed bottom-5 right-5 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-lg">
          Working...
        </div>
      ) : null}
    </main>
  );
}
