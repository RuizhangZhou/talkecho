import { Button, ScrollArea } from "@/components";
import { cn } from "@/lib/utils";
import { useLocation, useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMenuItems, useVersion } from "@/hooks";
import talkechoLogo from "../../images/talkecho.png";

export const Sidebar = () => {
  const { version, isLoading } = useVersion();
  const { menu, footerLinks, footerItems } = useMenuItems();

  const navigate = useNavigate();
  const activeRoute = useLocation().pathname;
  return (
    <aside className="flex h-full w-48 shrink-0 flex-col overflow-hidden select-none pt-2 lg:w-56">
      {/* Logo */}
      <div
        onClick={() => navigate("/dashboard")}
        className="flex h-16 items-center px-4 pt-10 gap-1.5"
      >
        <div className="flex items-center justify-center rounded-lg bg-primary p-1">
          <img
            src={talkechoLogo}
            alt="TalkEcho logo"
            className="h-5 w-5 lg:h-6 lg:w-6 rounded"
          />
        </div>
        <div className="flex flex-col">
          <h1 className="text-xs lg:text-md font-semibold text-foreground transition-all duration-300">
            TalkEcho
          </h1>
          <span className="text-[8px] lg:text-[10px] text-muted-foreground -mt-1 block">
            {isLoading ? "Loading..." : `(v${version})`}
          </span>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" scrollbars="vertical" type="always">
        <div className="flex min-h-full flex-col px-3 pb-3 pr-6">
          {/* Navigation */}
          <nav className="flex-1 space-y-1 py-6">
            {menu.map((item, index) => (
              <button
                onClick={() => navigate(item.href)}
                key={`${item.label}-${index}`}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs lg:text-sm text-sidebar-foreground/70 transition-all duration-300 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  activeRoute.includes(item.href)
                    ? "font-medium bg-sidebar-accent text-sidebar-accent-foreground"
                    : ""
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <item.icon className="size-3 shrink-0 lg:size-4 transition-all duration-300" />
                  <span className="truncate">{item.label}</span>
                </div>
                {item.count ? (
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                    {item.count}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="flex flex-col space-y-1">
            <div className="mb-3 flex flex-row items-center justify-evenly gap-2">
              {footerLinks.map((item, index) => (
                <Button
                  key={`${item.title}-${index}`}
                  title={item.title}
                  size="sm"
                  variant="outline"
                  onClick={() => openUrl(item.link)}
                >
                  <item.icon className="size-3 lg:size-4 transition-all duration-300" />
                </Button>
              ))}
            </div>

            {footerItems.map((item, index) => (
              <a
                href={item.href}
                onClick={item.action}
                target="_blank"
                rel="noopener noreferrer"
                key={`${item.label}-${index}`}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs lg:text-sm text-sidebar-foreground/70 transition-all duration-300 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <item.icon className="size-3 shrink-0 lg:size-4 transition-all duration-300" />
                  <span className="truncate">{item.label}</span>
                </div>
              </a>
            ))}
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
};

