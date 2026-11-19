import { Badge, Card, CardTitle, Empty } from "@astrafoundry/design/ui";
import { useEffect, useState } from "react";
import { api, type ProjectSummary } from "./api.ts";
import { t } from "./i18n.ts";

const TONE = { draft: "neutral", approved: "success", stale: "danger" } as const;

export function Overview() {
  const [projects, setProjects] = useState<ProjectSummary[]>();
  useEffect(() => {
    api.projects().then(setProjects, () => setProjects([]));
  }, []);
  if (!projects) return null;
  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="mb-8 font-display text-[40px] leading-none">{t.appName}</h1>
      {projects.length === 0 && <Empty title={t.noProjects} />}
      <div className="space-y-10">
        {projects.map((p) => (
          <section key={p.key}>
            <h2 className="mb-3 truncate font-mono text-[13px] text-muted-foreground">{p.dir}</h2>
            {p.features.length === 0 && <p className="text-muted-foreground">{t.noFeatures}</p>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
              {p.features.map((f) => (
                <a key={f.name} href={`/p/${p.key}/${f.name}`} className="rounded-2xl focus-visible:outline-2 focus-visible:outline-ring">
                  <Card className="h-full transition-colors hover:bg-art-cell-hover">
                    <CardTitle className="mb-3">{f.name}</CardTitle>
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <Badge tone={TONE[f.status]}>{t.status[f.status]}</Badge>
                      {f.openThreads > 0 && <span>{t.openThreads(f.openThreads)}</span>}
                    </div>
                  </Card>
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
