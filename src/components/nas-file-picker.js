"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ACTIVE_CONNECTION_KEY = "nas-sync-active-connection";
const ACTIVE_CONNECTION_PERSIST_KEY = "nas-sync-active-connection-persist";
const FAVORITES_KEY = "nas-picker-favorites";
const MAX_NAS_THUMBNAILS = 24;
const MAX_IMPORT_PARALLEL = 6;
const DOWNLOAD_MEMORY_BUDGET_BYTES = 320 * 1024 * 1024;

function normalizePath(pathname) {
  const raw = String(pathname || "/").trim();
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const compact = prefixed.replace(/\/+/g, "/").replace(/\/$/, "");
  return compact || "/";
}

function pathName(pathname) {
  const clean = normalizePath(pathname);
  return clean === "/" ? "/" : clean.split("/").filter(Boolean).at(-1);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
}

function getAdaptiveParallelism({ totalBytes, fileCount }) {
  if (!fileCount || fileCount <= 1) return 1;

  const averageBytes = totalBytes > 0 ? totalBytes / fileCount : 0;
  const averageMb = averageBytes / (1024 * 1024);

  const networkDownlink =
    typeof navigator !== "undefined" && navigator.connection
      ? Number(navigator.connection.downlink || 0)
      : 0;
  const cpuCores =
    typeof navigator !== "undefined"
      ? Number(navigator.hardwareConcurrency || 4)
      : 4;

  const byCpu = Math.max(2, Math.min(MAX_IMPORT_PARALLEL, Math.floor(cpuCores / 2)));
  const byNetwork =
    networkDownlink <= 0
      ? 3
      : networkDownlink < 8
        ? 2
        : networkDownlink < 25
          ? 3
          : networkDownlink < 60
            ? 4
            : MAX_IMPORT_PARALLEL;
  const byFileSize =
    averageMb >= 90
      ? 2
      : averageMb >= 35
        ? 3
        : averageMb >= 12
          ? 4
          : MAX_IMPORT_PARALLEL;
  const byMemory = averageBytes
    ? Math.max(1, Math.floor(DOWNLOAD_MEMORY_BUDGET_BYTES / averageBytes))
    : MAX_IMPORT_PARALLEL;

  return Math.max(
    1,
    Math.min(fileCount, byCpu, byNetwork, byFileSize, byMemory, MAX_IMPORT_PARALLEL),
  );
}

function isQuickConnectReady(connection) {
  return (
    connection &&
    connection.connectionMethod === "quickconnect" &&
    connection.quickConnectSession?.baseUrl &&
    connection.quickConnectSession?.sid
  );
}

export default function NasFilePicker({
  onImport,
  disabled = false,
  selectionMode = "multiple",
  importButtonLabel,
}) {
  const isSingleSelection = selectionMode === "single";
  const [nasConnection, setNasConnection] = useState(null);
  const [nasConnectionState, setNasConnectionState] = useState("idle");
  const [nasPickerOpen, setNasPickerOpen] = useState(false);
  const [nasCurrentPath, setNasCurrentPath] = useState("/");
  const [nasTree, setNasTree] = useState({
    "/": {
      path: "/",
      name: "/",
      children: [],
      expanded: true,
      loaded: false,
      isLoading: false,
      error: "",
    },
  });
  const [nasFolders, setNasFolders] = useState([]);
  const [nasFiles, setNasFiles] = useState([]);
  const [nasError, setNasError] = useState("");
  const [nasLoading, setNasLoading] = useState(false);
  const [nasSelectedPaths, setNasSelectedPaths] = useState([]);
  const [nasImporting, setNasImporting] = useState({
    running: false,
    done: 0,
    total: 0,
    failed: 0,
    parallelism: 1,
    downloadedBytes: 0,
    totalBytes: 0,
  });
  const [nasThumbMap, setNasThumbMap] = useState({});
  const [nasThumbStatus, setNasThumbStatus] = useState("idle");
  const [favorites, setFavorites] = useState([]);

  const nasThumbGenerationRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const activeRaw = sessionStorage.getItem(ACTIVE_CONNECTION_KEY);
      if (activeRaw) {
        const parsed = JSON.parse(activeRaw);
        if (isQuickConnectReady(parsed)) {
          setNasConnection(parsed);
          setNasConnectionState("connected");
        }
      }

      const persistedRaw = localStorage.getItem(ACTIVE_CONNECTION_PERSIST_KEY);
      if (persistedRaw) {
        const parsed = JSON.parse(persistedRaw);
        if (
          parsed?.connection &&
          Number(parsed.expiresAt || 0) > Date.now() &&
          isQuickConnectReady(parsed.connection)
        ) {
          setNasConnection(parsed.connection);
          setNasConnectionState("connected");
        }
      }

      const savedFavorites = localStorage.getItem(FAVORITES_KEY);
      if (savedFavorites) {
        const parsed = JSON.parse(savedFavorites);
        if (Array.isArray(parsed)) {
          setFavorites(parsed.map((item) => normalizePath(item)).slice(0, 20));
        }
      }

      if (!activeRaw && !persistedRaw) {
        setNasConnectionState("missing");
      }
    } catch {
      setNasConnectionState("missing");
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {
      // Ignore storage write errors.
    }
  }, [favorites]);

  useEffect(() => {
    return () => {
      Object.values(nasThumbMap).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [nasThumbMap]);

  const postNasJson = useCallback(async (url, payload) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok || json?.ok === false) {
      throw new Error(json?.message || "NAS request failed.");
    }

    return json;
  }, []);

  const updateTreeNode = useCallback((path, patch) => {
    setNasTree((prev) => ({
      ...prev,
      [path]: {
        ...(prev[path] || {
          path,
          name: pathName(path),
          children: [],
          expanded: false,
          loaded: false,
          isLoading: false,
          error: "",
        }),
        ...patch,
      },
    }));
  }, []);

  const loadNasPath = useCallback(
    async (path) => {
      if (!nasConnection?.quickConnectSession) {
        setNasError("No active QuickConnect session.");
        return;
      }

      const normalized = normalizePath(path);
      setNasCurrentPath(normalized);
      setNasLoading(true);
      setNasError("");
      updateTreeNode(normalized, {
        isLoading: true,
        error: "",
        expanded: true,
      });

      try {
        const data = await postNasJson("/api/quickconnect/browse", {
          session: nasConnection.quickConnectSession,
          path: normalized,
        });

        const nextFolders = data.folders || [];
        const nextFiles = data.files || [];

        setNasFolders(nextFolders);
        setNasFiles(nextFiles);
        setNasSelectedPaths([]);

        setNasTree((prev) => {
          const next = { ...prev };
          const children = [];

          for (const folder of nextFolders) {
            const folderPath = normalizePath(folder.path);
            children.push(folderPath);
            next[folderPath] = {
              ...(next[folderPath] || {
                path: folderPath,
                name: folder.name,
                children: [],
                expanded: false,
                loaded: false,
                isLoading: false,
                error: "",
              }),
              name: folder.name,
            };
          }

          next[normalized] = {
            ...(next[normalized] || {
              path: normalized,
              name: pathName(normalized),
            }),
            children,
            loaded: true,
            isLoading: false,
            error: "",
            expanded: true,
          };

          return next;
        });
      } catch (error) {
        const message = String(error?.message || "Cannot load NAS folder.");
        setNasError(message);
        updateTreeNode(normalized, { isLoading: false, error: message });
      } finally {
        setNasLoading(false);
      }
    },
    [nasConnection, postNasJson, updateTreeNode],
  );

  const toggleNasNode = useCallback(
    async (path) => {
      const normalized = normalizePath(path);
      const node = nasTree[normalized];
      if (!node) {
        updateTreeNode(normalized, { expanded: true });
        await loadNasPath(normalized);
        return;
      }

      const nextExpanded = !node.expanded;
      updateTreeNode(normalized, { expanded: nextExpanded });
      if (nextExpanded && !node.loaded && !node.isLoading) {
        await loadNasPath(normalized);
      }
    },
    [loadNasPath, nasTree, updateTreeNode],
  );

  const openNasPicker = async () => {
    if (!isQuickConnectReady(nasConnection)) {
      setNasConnectionState("missing");
      return;
    }

    setNasPickerOpen(true);
    await loadNasPath(nasCurrentPath || "/");
  };

  const closeNasPicker = () => {
    setNasPickerOpen(false);
    setNasError("");
  };

  useEffect(() => {
    if (
      !nasPickerOpen ||
      !nasFiles.length ||
      !nasConnection?.quickConnectSession
    ) {
      return;
    }

    const generation = nasThumbGenerationRef.current + 1;
    nasThumbGenerationRef.current = generation;

    setNasThumbStatus("loading");
    setNasThumbMap((prev) => {
      Object.values(prev).forEach((url) => URL.revokeObjectURL(url));
      return {};
    });

    const targets = nasFiles.slice(0, MAX_NAS_THUMBNAILS);
    if (!targets.length) {
      setNasThumbStatus("idle");
      return;
    }

    const run = async () => {
      const chunkSize = 6;

      for (let i = 0; i < targets.length; i += chunkSize) {
        const chunk = targets.slice(i, i + chunkSize);

        await Promise.all(
          chunk.map(async (file) => {
            try {
              const response = await fetch("/api/quickconnect/thumbnail", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  session: nasConnection.quickConnectSession,
                  path: file.path,
                  size: "small",
                }),
                cache: "no-store",
              });

              if (!response.ok) return;
              const blob = await response.blob();
              if (!blob.type.startsWith("image/")) return;

              if (nasThumbGenerationRef.current !== generation) return;

              const objectUrl = URL.createObjectURL(blob);
              setNasThumbMap((prev) => {
                const old = prev[file.path];
                if (old) URL.revokeObjectURL(old);
                return {
                  ...prev,
                  [file.path]: objectUrl,
                };
              });
            } catch {
              // Ignore thumbnail failure for a single file.
            }
          }),
        );

        if (nasThumbGenerationRef.current !== generation) {
          return;
        }
      }

      if (nasThumbGenerationRef.current === generation) {
        setNasThumbStatus("idle");
      }
    };

    run();
  }, [nasConnection, nasFiles, nasPickerOpen]);

  const toggleSelectNasFile = (path) => {
    const normalized = normalizePath(path);
    setNasSelectedPaths((prev) => {
      if (isSingleSelection) {
        return prev[0] === normalized ? [] : [normalized];
      }

      return prev.includes(normalized)
        ? prev.filter((item) => item !== normalized)
        : [...prev, normalized];
    });
  };

  const toggleFavorite = (path) => {
    const normalized = normalizePath(path);
    setFavorites((prev) =>
      prev.includes(normalized)
        ? prev.filter((item) => item !== normalized)
        : [normalized, ...prev.filter((item) => item !== normalized)].slice(
            0,
            20,
          ),
    );
  };

  const favoritesWithLabel = useMemo(
    () => favorites.map((path) => ({ path, name: pathName(path) || path })),
    [favorites],
  );

  const importFromNas = async () => {
    if (!nasSelectedPaths.length || !nasConnection?.quickConnectSession) return;

    const fileMap = new Map(
      nasFiles.map((item) => [normalizePath(item.path), item]),
    );

    const selectedEntries = nasSelectedPaths.map((selectedPath) => {
      const info = fileMap.get(selectedPath);
      return {
        path: selectedPath,
        size: Number(info?.size || 0),
      };
    });

    const totalBytes = selectedEntries.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry.size || 0)),
      0,
    );
    const parallelism = getAdaptiveParallelism({
      totalBytes,
      fileCount: selectedEntries.length,
    });

    const imported = [];
    const perFileDownloaded = new Map();

    setNasImporting({
      running: true,
      done: 0,
      total: nasSelectedPaths.length,
      failed: 0,
      parallelism,
      downloadedBytes: 0,
      totalBytes,
    });

    try {
      const downloadOne = async (entry) => {
        const selectedPath = entry.path;
        const knownSize = Math.max(0, Number(entry.size || 0));

        const response = await fetch("/api/quickconnect/read-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session: nasConnection.quickConnectSession,
            path: selectedPath,
          }),
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Cannot read NAS file: ${selectedPath}`);
        }

        const contentType = response.headers.get("content-type") || "image/jpeg";
        const contentLength = Number(response.headers.get("content-length") || 0);
        const reader = response.body?.getReader();
        let blob;

        if (knownSize <= 0 && contentLength > 0) {
          setNasImporting((prev) => ({
            ...prev,
            totalBytes: prev.totalBytes + contentLength,
          }));
        }

        if (!reader) {
          blob = await response.blob();
          if (knownSize <= 0 && contentLength <= 0 && blob.size > 0) {
            setNasImporting((prev) => ({
              ...prev,
              totalBytes: prev.totalBytes + blob.size,
            }));
          }
          perFileDownloaded.set(selectedPath, blob.size);
          setNasImporting((prev) => ({
            ...prev,
            downloadedBytes: prev.downloadedBytes + blob.size,
          }));
        } else {
          const chunks = [];
          let loaded = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            chunks.push(value);
            loaded += value.byteLength;

            const previousLoaded = perFileDownloaded.get(selectedPath) || 0;
            const delta = loaded - previousLoaded;
            if (delta > 0) {
              perFileDownloaded.set(selectedPath, loaded);
              setNasImporting((prev) => ({
                ...prev,
                downloadedBytes: prev.downloadedBytes + delta,
              }));
            }
          }

          if (knownSize <= 0 && contentLength <= 0 && loaded > 0) {
            setNasImporting((prev) => ({
              ...prev,
              totalBytes: prev.totalBytes + loaded,
            }));
          }

          blob = new Blob(chunks, { type: contentType });
        }

        const fileInfo = fileMap.get(selectedPath);
        const fallbackName = pathName(selectedPath) || "nas-image";
        const fileName = fileInfo?.name || fallbackName;
        const fileType = blob.type || contentType || "image/jpeg";

        imported.push(
          new File([blob], fileName, {
            type: fileType,
            lastModified: Date.now(),
          }),
        );

        setNasImporting((prev) => ({
          ...prev,
          done: prev.done + 1,
        }));
      };

      const queue = [...selectedEntries];
      const workers = Array.from({ length: parallelism }, async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) return;

          try {
            await downloadOne(next);
          } catch {
            setNasImporting((prev) => ({
              ...prev,
              done: prev.done + 1,
              failed: prev.failed + 1,
            }));
          }
        }
      });

      await Promise.all(workers);

      const accurateDownloadedBytes = Array.from(perFileDownloaded.values()).reduce(
        (sum, bytes) => sum + bytes,
        0,
      );

      setNasImporting((prev) => ({
        ...prev,
        downloadedBytes: accurateDownloadedBytes,
      }));

      if (imported.length === 0) {
        throw new Error("No files were imported. Please retry.");
      }

      if (typeof onImport === "function") {
        onImport(imported);
      }
      closeNasPicker();
    } catch (error) {
      alert(`Import from NAS failed: ${error.message}`);
    } finally {
      setNasImporting({
        running: false,
        done: 0,
        total: 0,
        failed: 0,
        parallelism: 1,
        downloadedBytes: 0,
        totalBytes: 0,
      });
    }
  };

  const selectedTotalBytes = useMemo(() => {
    const fileMap = new Map(nasFiles.map((item) => [normalizePath(item.path), item]));
    return nasSelectedPaths.reduce((sum, path) => {
      const info = fileMap.get(path);
      return sum + Math.max(0, Number(info?.size || 0));
    }, 0);
  }, [nasFiles, nasSelectedPaths]);

  const predictedParallelism = useMemo(
    () =>
      getAdaptiveParallelism({
        totalBytes: selectedTotalBytes,
        fileCount: nasSelectedPaths.length,
      }),
    [nasSelectedPaths.length, selectedTotalBytes],
  );

  const overallProgressPercent = useMemo(() => {
    if (!nasImporting.totalBytes) return 0;
    return (nasImporting.downloadedBytes / nasImporting.totalBytes) * 100;
  }, [nasImporting.downloadedBytes, nasImporting.totalBytes]);

  const effectiveImportButtonLabel =
    importButtonLabel ||
    (isSingleSelection ? "Import selected image" : "Import selected images");

  const renderTreeNode = (path, depth = 0) => {
    const node = nasTree[path];
    if (!node) return null;
    const isFavorite = favorites.includes(path);

    return (
      <li key={path} className="space-y-1">
        <div
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${
            nasCurrentPath === path ? "bg-slate-200" : ""
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center rounded border border-slate-300 bg-white text-xs"
            onClick={() => toggleNasNode(path)}
          >
            {node.expanded ? "-" : "+"}
          </button>
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => loadNasPath(path)}
          >
            {node.name || "/"}
          </button>
          <button
            type="button"
            className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs ${
              isFavorite ? "bg-amber-100 text-amber-700" : "text-slate-400"
            }`}
            onClick={() => toggleFavorite(path)}
            title={isFavorite ? "Remove favorite" : "Add to favorites"}
          >
            *
          </button>
        </div>

        {node.error ? (
          <p
            className="text-xs text-red-600"
            style={{ paddingLeft: `${36 + depth * 14}px` }}
          >
            {node.error}
          </p>
        ) : null}
        {node.expanded && node.children.length > 0 ? (
          <ul className="space-y-1">
            {node.children.map((child) => renderTreeNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={openNasPicker}
        disabled={disabled || !isQuickConnectReady(nasConnection)}
        className="rounded-md border border-slate-300 bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Pick from Synology NAS
      </button>

      {!isQuickConnectReady(nasConnection) ? (
        <p className="mt-2 text-xs text-amber-700">
          NAS picker requires an active QuickConnect session. Please connect at
          NAS Sync first.
        </p>
      ) : null}
      {nasConnectionState === "connected" ? (
        <p className="mt-2 text-xs text-emerald-700">
          Synology session detected. Ready to browse NAS.
        </p>
      ) : null}

      {nasPickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-3">
          <div className="flex h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Synology NAS File Picker
                </p>
                <p className="text-xs text-slate-600">{nasCurrentPath}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  onClick={() => loadNasPath(nasCurrentPath)}
                  disabled={nasLoading || nasImporting.running}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  onClick={closeNasPicker}
                  disabled={nasImporting.running}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_1fr]">
              <aside className="min-h-0 overflow-auto border-b border-slate-200 bg-slate-50 p-3 lg:border-b-0 lg:border-r">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Favorites
                </p>
                {favoritesWithLabel.length ? (
                  <ul className="mb-4 space-y-1">
                    {favoritesWithLabel.map((fav) => (
                      <li key={fav.path}>
                        <button
                          type="button"
                          onClick={() => loadNasPath(fav.path)}
                          className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs hover:bg-slate-100"
                        >
                          <span className="truncate">{fav.path}</span>
                          <span className="text-amber-600">*</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mb-4 text-xs text-slate-500">
                    No favorites yet.
                  </p>
                )}

                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Folder tree
                </p>
                <ul className="space-y-1">{renderTreeNode("/")}</ul>
              </aside>

              <section className="min-h-0 overflow-auto bg-white p-3">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      if (nasCurrentPath === "/") return;
                      const parts = nasCurrentPath.split("/").filter(Boolean);
                      parts.pop();
                      loadNasPath(parts.length ? `/${parts.join("/")}` : "/");
                    }}
                    disabled={nasLoading}
                  >
                    Up
                  </button>
                  <p className="text-xs text-slate-600">
                    {nasFolders.length} folders, {nasFiles.length} image files
                  </p>
                  {nasThumbStatus === "loading" ? (
                    <p className="text-xs text-amber-700">
                      Loading thumbnails...
                    </p>
                  ) : null}
                </div>

                {nasError ? (
                  <p className="mb-3 text-sm text-red-600">{nasError}</p>
                ) : null}

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {nasFolders.map((folder) => (
                    <button
                      key={folder.path}
                      type="button"
                      onDoubleClick={() => loadNasPath(folder.path)}
                      onClick={() =>
                        setNasCurrentPath(normalizePath(folder.path))
                      }
                      className={`group rounded-xl border p-3 text-left transition ${
                        nasCurrentPath === normalizePath(folder.path)
                          ? "border-slate-800 bg-slate-100"
                          : "border-slate-200 bg-white hover:border-slate-400"
                      }`}
                    >
                      <div className="mb-2 flex h-24 items-center justify-center rounded-lg bg-gradient-to-br from-amber-100 to-yellow-200 text-3xl">
                        <span>F</span>
                      </div>
                      <p className="truncate text-xs font-medium text-slate-700">
                        {folder.name}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Double click to open
                      </p>
                    </button>
                  ))}

                  {nasFiles.map((file) => {
                    const normalized = normalizePath(file.path);
                    const selected = nasSelectedPaths.includes(normalized);
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => toggleSelectNasFile(file.path)}
                        className={`rounded-xl border p-2 text-left transition ${
                          selected
                            ? "border-blue-600 bg-blue-50"
                            : "border-slate-200 bg-white hover:border-slate-400"
                        }`}
                      >
                        <div className="mb-2 flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-slate-100">
                          {nasThumbMap[file.path] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={nasThumbMap[file.path]}
                              alt={file.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="text-xs text-slate-500">IMG</span>
                          )}
                        </div>
                        <p className="truncate text-xs font-medium text-slate-700">
                          {file.name}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {formatBytes(file.size || 0)}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {!nasLoading &&
                nasFolders.length === 0 &&
                nasFiles.length === 0 ? (
                  <p className="mt-6 text-sm text-slate-500">
                    Folder is empty.
                  </p>
                ) : null}
              </section>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs text-slate-600">
                {nasSelectedPaths.length} file{nasSelectedPaths.length > 1 ? "s" : ""} selected
                {isSingleSelection ? " (single mode)" : ""}
              </p>
              {nasSelectedPaths.length > 0 && !nasImporting.running ? (
                <p className="text-xs text-slate-600">
                  Total size: {formatBytes(selectedTotalBytes)} | Auto parallel: {predictedParallelism}
                </p>
              ) : null}
              {nasImporting.running ? (
                <div className="w-full space-y-1 sm:w-[360px]">
                  <div className="flex items-center justify-between text-xs text-slate-700">
                    <span>
                      Importing {nasImporting.done}/{nasImporting.total} | Parallel: {nasImporting.parallelism}
                    </span>
                    <span>{formatPercent(overallProgressPercent)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all duration-200"
                      style={{ width: `${Math.max(0, Math.min(100, overallProgressPercent))}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>
                      {formatBytes(nasImporting.downloadedBytes)} / {formatBytes(nasImporting.totalBytes)}
                    </span>
                    {nasImporting.failed > 0 ? (
                      <span className="text-amber-700">Failed: {nasImporting.failed}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <button
                type="button"
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={importFromNas}
                disabled={nasImporting.running || nasSelectedPaths.length === 0}
              >
                  {effectiveImportButtonLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
