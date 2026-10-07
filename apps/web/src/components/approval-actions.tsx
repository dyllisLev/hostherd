import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { t, type MessageKey } from '../i18n';
import { post, useAction } from '../lib/api';
import type { Approval } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge, Button, ConfirmDialog, ErrorNotice, toast } from './ui';

export const ruleLabel = (id: string) => { const key = `approvals.rule.${id}` as MessageKey; const text = t(key); return text === key ? id : text; };

export function RuleBadges({ rules, names }: { rules: string[]; names?: string[] }) {
  // User rules have no translation; their saved name comes with the request.
  return <div className="flex flex-wrap gap-1.5">{rules.map((rule, index) => <Badge key={rule}>{rule.startsWith('custom-') ? names?.[index] ?? rule : ruleLabel(rule)}</Badge>)}</div>;
}

/** Deny, approve once or always approve a pending request. */
export function ApprovalActions({ approval, size, className }: { approval: Approval; size?: 'sm'; className?: string }) {
  const action = useAction();
  const [always, setAlways] = useState(false);
  const decide = (decision: 'approve' | 'deny', forever = false) => void action.run(async () => {
    await post(`/api/approvals/${approval.id}/decision`, { decision, always: forever });
    setAlways(false);
    if (decision === 'deny') toast.success(t('approvals.deniedToast'));
    else toast.success(t(forever ? 'approvals.alwaysDone' : 'approvals.approved'));
  });
  return <>
    {!always && <ErrorNotice message={action.error} />}
    <div className={cn('flex flex-wrap justify-end gap-2', className)}>
      <Button variant="outline" size={size} disabled={action.busy} onClick={() => decide('deny')}>{t('approvals.deny')}</Button>
      <Button variant="outline" size={size} disabled={action.busy} onClick={() => decide('approve')}>{t('approvals.approveOnce')}</Button>
      <Button size={size} disabled={action.busy} onClick={() => setAlways(true)}><ShieldCheck />{t('approvals.approveAlways')}</Button>
    </div>
    <ConfirmDialog open={always} onOpenChange={setAlways} title={t('approvals.alwaysTitle')} description={t('approvals.alwaysDescription')} confirmLabel={t('approvals.approveAlways')}
      onConfirm={() => decide('approve', true)} busy={action.busy} error={action.error}><RuleBadges rules={approval.rules} names={approval.ruleNames} />{approval.rules.some(rule => rule.startsWith('custom-')) && <p className="mt-2 text-xs text-muted-foreground">{t('approvals.customNotAllowed')}</p>}</ConfirmDialog>
  </>;
}
