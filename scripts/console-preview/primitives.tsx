import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { consoleStylesheetPath } from "../../src/console/app";
import { Badge } from "../../src/console/ui/components/badge";
import { Button } from "../../src/console/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../src/console/ui/components/empty";
import { InfoPopover } from "../../src/console/ui/components/info-popover";
import { Input } from "../../src/console/ui/components/input";
import { Label } from "../../src/console/ui/components/label";
import { Progress } from "../../src/console/ui/components/progress";
import { StatusSwitch } from "../../src/console/ui/components/status-switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../src/console/ui/components/table";
import { ConfirmationFallback } from "../../src/console/ui/fields";

function Specimen({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="panel" data-primitive={title} aria-label={title}><div className="panel-head"><h2>{title}</h2></div><div className="view-stack">{children}</div></section>;
}

/**
 * Server-rendered primitive states with the production stylesheet. This is a review
 * surface, not a design authority: appearance stays owned by the components and tokens.
 * SSR shows the pre-hydration (native) rendering of each primitive.
 */
export function renderPrimitiveGallery(): string {
  return "<!doctype html>" + renderToString(
    <html lang="zh-CN">
      <head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="light dark" /><title>Primitives</title><link rel="stylesheet" href={consoleStylesheetPath()} /></head>
      <body className="console-simple">
        <main id="content" className="view-stack" data-primitive-gallery="">
          <h1>Primitives</h1>
          <Specimen title="Button">
            <p>{(["default", "outline", "secondary", "ghost", "destructive", "link"] as const).map(variant => <Button key={variant} type="button" variant={variant}>{variant}</Button>)}</p>
            <p><Button type="button" size="sm">sm</Button><Button type="button" size="lg">lg</Button><Button type="button" disabled>disabled</Button></p>
          </Specimen>
          <Specimen title="Badge">
            <p><Badge>neutral</Badge><Badge data-tone="ok">已启用</Badge><Badge data-tone="bad">已停用</Badge><Badge data-key-state="active">有效</Badge><Badge data-key-state="expired">已过期</Badge><Badge data-key-state="revoked">已撤销</Badge></p>
          </Specimen>
          <Specimen title="StatusSwitch">
            <form className="inline-form"><StatusSwitch enabled label="lin@example.test" /></form>
            <form className="inline-form"><StatusSwitch enabled={false} label="chen@example.test" /></form>
          </Specimen>
          <Specimen title="InfoPopover">
            <InfoPopover id="gallery-help" label="说明"><p>帮助内容。</p></InfoPopover>
            <InfoPopover id="gallery-help-icon" label="说明" iconOnly><p>帮助内容。</p></InfoPopover>
          </Specimen>
          <Specimen title="ConfirmationFallback">
            <form className="inline-form" data-confirmation="撤销此密钥？"><ConfirmationFallback message="撤销此密钥？此密钥立即且永久失效。" /><Button type="submit" variant="destructive">撤销</Button></form>
            <form className="inline-form" data-confirmation="停用额度？"><ConfirmationFallback message="停用额度？新请求立即被拒绝。" /><Button type="submit" variant="outline">保存</Button></form>
          </Specimen>
          <Specimen title="Input">
            <p><Label htmlFor="gallery-input">名称</Label><Input id="gallery-input" defaultValue="工作电脑" /></p>
            <p><Label htmlFor="gallery-invalid">名称</Label><Input id="gallery-invalid" aria-invalid="true" defaultValue="" /></p>
          </Specimen>
          <Specimen title="Progress">
            {[0, 40, 100].map(value => <Progress key={value} value={value} aria-label={`${value}%`} />)}
          </Specimen>
          <Specimen title="Table">
            <Table scrollLabel="示例表格"><TableHeader><TableRow><TableHead scope="col">名称</TableHead><TableHead scope="col">状态</TableHead><TableHead scope="col" className="number">令牌</TableHead></TableRow></TableHeader><TableBody>
              <TableRow><TableCell>工作电脑</TableCell><TableCell><Badge data-key-state="active">有效</Badge></TableCell><TableCell className="number">12,400</TableCell></TableRow>
              <TableRow><TableCell>long.department.and.project.name</TableCell><TableCell><Badge data-key-state="revoked">已撤销</Badge></TableCell><TableCell className="number">—</TableCell></TableRow>
            </TableBody></Table>
          </Specimen>
          <Specimen title="Empty">
            <Empty role="status"><EmptyHeader><EmptyTitle>暂无用量记录</EmptyTitle><EmptyDescription>所选时间范围内没有记录。</EmptyDescription></EmptyHeader></Empty>
          </Specimen>
        </main>
      </body>
    </html>
  );
}
