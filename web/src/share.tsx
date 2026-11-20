import { Button, Menu, MenuItem, MenuPopup, MenuSeparator, MenuSubmenu, MenuSubmenuPopup, MenuSubmenuTrigger, MenuTrigger } from "@astrafoundry/design/ui";
import { Check, Copy, FileCode, Image, Link, Share } from "lucide-react";
import { useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";

/** Share: the flow as an HTML file, as a picture, or as a secret-gist link. */
export function ShareMenu({
  project,
  feature,
  onExportPng,
}: {
  project: string;
  feature: string;
  /** Export the canvas as a PNG, with or without comment pins. */
  onExportPng: (withComments: boolean) => void;
}) {
  const [link, setLink] = useState<{ state: "idle" | "busy" | "done" | "error"; url?: string; error?: string }>({ state: "idle" });
  const [copied, setCopied] = useState(false);
  const makeLink = () => {
    setLink({ state: "busy" });
    api.share(project, feature).then(
      (r) => {
        setLink({ state: "done", url: r.url });
        void navigator.clipboard?.writeText(r.url).then(() => setCopied(true), () => undefined);
      },
      (e: Error) => setLink({ state: "error", error: e.message }),
    );
  };
  return (
    <Menu onOpenChange={(o) => !o && setCopied(false)}>
      <MenuTrigger render={<Button size="sm" variant="secondary" />}>
        <Share size={15} />
        {t.share}
      </MenuTrigger>
      <MenuPopup align="end" sideOffset={8} className="w-72">
        <MenuItem onClick={() => (location.href = `${api.feature(project, feature)}/share.html`)}>
          <FileCode size={15} />
          {t.exportHtml}
        </MenuItem>
        <MenuSubmenu>
          <MenuSubmenuTrigger>
            <Image size={15} />
            {t.exportPng}
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuItem onClick={() => onExportPng(false)}>{t.exportWithoutComments}</MenuItem>
            <MenuItem onClick={() => onExportPng(true)}>{t.exportWithComments}</MenuItem>
          </MenuSubmenuPopup>
        </MenuSubmenu>
        <MenuSeparator />
        <MenuItem closeOnClick={false} disabled={link.state === "busy"} onClick={link.state === "done" ? () => void navigator.clipboard?.writeText(link.url!).then(() => setCopied(true)) : makeLink}>
          {link.state === "done" ? copied ? <Check size={15} /> : <Copy size={15} /> : <Link size={15} />}
          {link.state === "busy" ? t.linkBusy : link.state === "done" ? (copied ? t.linkCopied : t.copyLink) : t.makeLink}
        </MenuItem>
        {link.state === "done" && (
          <a href={link.url} target="_blank" rel="noreferrer" className="block truncate px-3 pb-2 text-[12px] text-muted-foreground underline underline-offset-2">
            {link.url}
          </a>
        )}
        {link.state === "error" && (
          <p role="alert" className="px-3 pb-2 text-[12px] leading-snug" style={{ color: "var(--danger)" }}>
            {link.error}
          </p>
        )}
      </MenuPopup>
    </Menu>
  );
}
