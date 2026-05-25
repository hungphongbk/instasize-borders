"use client";

import { useRef, useState } from "react";

export default function HomePage() {
  const [items, setItems] = useState([]);
  const [borderColor, setBorderColor] = useState("#ffffff");
  const [extraPx, setExtraPx] = useState(0);
  const inputRef = useRef(null);

  const onFiles = (files) => {
    if (!files) return;
    const next = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      next.push({
        file: f,
        previewUrl: URL.createObjectURL(f),
        borderColor,
        extraPx,
        ratio: "1:1",
      });
    }
    setItems((prev) => [...prev, ...next]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const removeItem = (idx) => {
    setItems((prev) => {
      URL.revokeObjectURL(prev[idx].previewUrl);
      const arr = [...prev];
      arr.splice(idx, 1);
      return arr;
    });
  };

  const processAndDownload = async () => {
    if (!items.length) return;

    const form = new FormData();
    items.forEach((it) => form.append("files", it.file));
    form.append(
      "options",
      JSON.stringify(
        items.map((it) => ({
          ratio: it.ratio,
          borderColor,
          extraPx,
        }))
      )
    );

    const res = await fetch("/api/process", { method: "POST", body: form });
    if (!res.ok) {
      const msg = await res.text();
      alert(`Processing failed: ${msg}`);
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bordered_images.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const totalCount = items.length;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl p-6">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">
            InstaSize-style Borders (1:1 / 16:9)
          </h1>
          <p className="text-sm text-gray-600">
            Upload multiple images, add borders, then download all as a ZIP. We
            keep the original pixels (no downscaling); the canvas expands to fit
            the selected ratio.
          </p>
        </header>

        <div className="mb-6 rounded-lg border-2 border-dashed border-gray-300 bg-white p-6">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => onFiles(e.target.files)}
            className="block w-full text-sm"
          />
          <p className="mt-2 text-xs text-gray-500">
            Tip: You can re-upload more images; they’ll be appended.
          </p>
        </div>

        {/* Global border color & extra border controls */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
          <div>
            <label className="block text-sm font-medium mb-1">
              Border color
            </label>
            <input
              type="color"
              value={borderColor}
              onChange={(e) => {
                setBorderColor(e.target.value);
                setItems((prev) =>
                  prev.map((it) => ({ ...it, borderColor: e.target.value }))
                );
              }}
              className="h-8 w-16 cursor-pointer rounded"
              aria-label="Border color"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium mb-1">
              Extra border (px)
            </label>
            <input
              type="number"
              min={0}
              max={2000}
              value={extraPx}
              onChange={(e) => {
                const val = Math.max(
                  0,
                  Math.min(2000, Number(e.target.value) || 0)
                );
                setExtraPx(val);
                setItems((prev) => prev.map((it) => ({ ...it, extraPx: val })));
              }}
              className="w-full rounded border px-2 py-1 text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              Optional extra padding added beyond what’s required to reach the
              ratio.
            </p>
          </div>
        </div>

        {totalCount > 0 && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-gray-700">
                {totalCount} image{totalCount > 1 ? "s" : ""} ready
              </p>
              <button
                onClick={processAndDownload}
                className="rounded-md bg-black px-4 py-2 text-white hover:bg-gray-800"
                title="Process server-side with Sharp and get a ZIP"
              >
                Process & Download ZIP
              </button>
            </div>

            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((it, idx) => (
                <li
                  key={idx}
                  className="rounded-lg border bg-white p-3 shadow-sm"
                >
                  <div className="relative mb-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={it.previewUrl}
                      alt={it.file.name}
                      className="h-48 w-full rounded-md object-cover"
                      style={{ border: `8px solid ${borderColor}` }}
                    />
                    <button
                      onClick={() => removeItem(idx)}
                      className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-1 text-xs shadow hover:bg-white"
                      title="Remove this image"
                    >
                      ✕
                    </button>
                    <button
                      onClick={async () => {
                        const form = new FormData();
                        form.append("file", it.file);
                        form.append(
                          "options",
                          JSON.stringify({
                            ratio: it.ratio,
                            borderColor: it.borderColor,
                            extraPx: it.extraPx,
                          })
                        );
                        const res = await fetch("/api/process/single", {
                          method: "POST",
                          body: form,
                        });
                        if (!res.ok) {
                          const msg = await res.text();
                          alert(`Download failed: ${msg}`);
                          return;
                        }
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `bordered_${it.file.name}`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                      }}
                      className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-1 text-xs shadow hover:bg-white border border-gray-300"
                      title="Download this image with border"
                    >
                      ⬇
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">
                        Aspect ratio
                      </label>
                      <select
                        value={it.ratio}
                        onChange={(e) =>
                          setItems((prev) => {
                            const arr = [...prev];
                            arr[idx] = { ...arr[idx], ratio: e.target.value };
                            return arr;
                          })
                        }
                        className="rounded border px-2 py-1 text-sm"
                      >
                        <option value="1:1">1 : 1</option>
                        <option value="16:9">16 : 9</option>
                      </select>
                    </div>

                    <div className="text-[11px] text-gray-500">
                      File: {it.file.name}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
