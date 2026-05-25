import Link from "next/link";

const MENU_ITEMS = [
  {
    key: "border",
    href: "/border",
    title: "Border",
    subtitle: "Add borders to images (tool hiện tại)",
    accent: "from-orange-500 to-amber-300",
    icon: (
      <svg viewBox="0 0 120 120" className="h-28 w-28" aria-hidden>
        <rect x="14" y="14" width="92" height="92" rx="16" fill="#fff" />
        <rect
          x="34"
          y="34"
          width="52"
          height="52"
          rx="8"
          fill="#fdba74"
          stroke="#111"
          strokeWidth="4"
        />
        <rect
          x="14"
          y="14"
          width="92"
          height="92"
          rx="16"
          fill="none"
          stroke="#111"
          strokeWidth="6"
        />
      </svg>
    ),
  },
  {
    key: "scrl",
    href: "/scrl",
    title: "SCRL",
    subtitle: "Split ảnh thành các frame liên tiếp để đăng carousel",
    accent: "from-cyan-500 to-sky-300",
    icon: (
      <svg viewBox="0 0 120 120" className="h-28 w-28" aria-hidden>
        <rect x="8" y="20" width="30" height="80" rx="8" fill="#fff" />
        <rect x="45" y="20" width="30" height="80" rx="8" fill="#fff" />
        <rect x="82" y="20" width="30" height="80" rx="8" fill="#fff" />
        <path d="M16 70h88" stroke="#111" strokeWidth="4" strokeDasharray="6 4" />
        <rect
          x="8"
          y="20"
          width="104"
          height="80"
          rx="8"
          fill="none"
          stroke="#111"
          strokeWidth="5"
        />
      </svg>
    ),
  },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#fff5e6_0%,#eaf8ff_40%,#f8fafc_100%)] px-5 py-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="text-center">
          <p className="mb-3 inline-block rounded-full border border-black/10 bg-white/70 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-slate-700">
            Insta Tools Hub
          </p>
          <h1 className="text-balance text-4xl font-semibold text-slate-900 sm:text-5xl">
            Chọn công cụ bạn muốn dùng
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-slate-600 sm:text-base">
            Home gồm 2 menu lớn: Border và SCRL. Border giữ nguyên logic hiện
            tại, SCRL dành cho cắt ảnh carousel theo frame liên tiếp.
          </p>
        </header>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {MENU_ITEMS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className="group relative overflow-hidden rounded-3xl border border-black/10 bg-white p-6 shadow-[0_18px_50px_-30px_rgba(15,23,42,0.45)] transition-all hover:-translate-y-0.5 hover:shadow-[0_20px_50px_-25px_rgba(15,23,42,0.55)]"
            >
              <div
                className={`absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r ${item.accent}`}
              />
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <div className="rounded-2xl border border-black/10 bg-slate-100 p-4 text-slate-900 transition-transform group-hover:scale-[1.02]">
                  {item.icon}
                </div>
                <div>
                  <h2 className="text-3xl font-semibold text-slate-900">
                    {item.title}
                  </h2>
                  <p className="mt-2 text-sm text-slate-600 sm:text-base">
                    {item.subtitle}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">
                    Open tool
                    <span aria-hidden>{">"}</span>
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
