"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart2, MessageCircle, BookOpen, Settings, Sun, Moon, Smartphone, Terminal, History } from "lucide-react";
import { useEffect, useState } from "react";

const NAV_ITEMS = [
  { href: "/", icon: BarChart2, label: "仪表盘" },
  { href: "/review", icon: BarChart2, label: "复盘" },
  { href: "/timeline", icon: History, label: "时间轴" },
  { href: "/chat", icon: MessageCircle, label: "对话" },
  { href: "/diary", icon: BookOpen, label: "解离日记" },
  { href: "/apps", icon: Smartphone, label: "应用与网站" },
  { href: "/dev", icon: Terminal, label: "信号监控" },
  { href: "/settings", icon: Settings, label: "设置" },
];

export function NavSidebar() {
  const pathname = usePathname();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "dark") { setDark(true); document.documentElement.setAttribute("data-theme", "dark"); }
    else if (saved === "light") { document.documentElement.setAttribute("data-theme", "light"); }
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  return (
    <nav className="nav-sidebar">
      {NAV_ITEMS.map(({ href, icon: Icon, label }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`nav-link${active ? " active" : ""}`}
            data-tooltip={label}
          >
            <Icon size={20} />
          </Link>
        );
      })}
      <div className="nav-spacer" />
      <button
        className="nav-link"
        onClick={toggleTheme}
        data-tooltip={dark ? "浅色模式" : "深色模式"}
        style={{ background: "none", border: "none", cursor: "pointer" }}
      >
        {dark ? <Sun size={20} /> : <Moon size={20} />}
      </button>
    </nav>
  );
}
