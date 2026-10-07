import { ArrowRight, LoaderCircle } from 'lucide-react';
import { Logo } from '../components/brand';
import { useState, type FormEvent } from 'react';
import { Button, Card, ErrorNotice, Field, Input, Segmented } from '../components/ui';
import { localeNames, locales, setLocale, t, useLocale } from '../i18n';
import { post, useAction } from '../lib/api';

export function AuthPage({ setup, onAuthenticated }: { setup: boolean; onAuthenticated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const action = useAction();
  const locale = useLocale();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      await post(setup ? '/api/setup' : '/api/login', { username, password, ...(setup ? { setupToken } : {}) });
      setPassword(''); setSetupToken(''); onAuthenticated();
    });
  };
  return <div className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-5 py-10">
    <div className="mb-8 flex items-center gap-2.5 text-xl font-semibold tracking-tight"><Logo className="size-9" />Hostherd</div>
    <Card className="w-full max-w-md p-7 sm:p-8">
      <div className="mb-7"><h1 className="text-xl font-semibold tracking-tight">{setup ? t('auth.setupTitle') : t('auth.loginTitle')}</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{setup ? t('auth.setupDescription') : t('auth.loginDescription')}</p></div>
      <form className="space-y-5" onSubmit={submit}>
        {setup && <Field label={t('auth.setupToken')} htmlFor="setup-token" hint={t('auth.setupTokenHint')}><Input id="setup-token" type="password" value={setupToken} onChange={event => setSetupToken(event.target.value)} required autoComplete="off" autoFocus /></Field>}
        <Field label={t('auth.username')} htmlFor="username"><Input id="username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required autoFocus={!setup} /></Field>
        <Field label={t('auth.password')} htmlFor="password" hint={setup ? t('auth.passwordHint') : undefined}><Input id="password" type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={setup ? 8 : undefined} autoComplete={setup ? 'new-password' : 'current-password'} required /></Field>
        <ErrorNotice message={action.error} />
        <Button type="submit" className="w-full" disabled={action.busy}>{action.busy ? <LoaderCircle className="animate-spin" /> : null}{action.busy ? t('auth.checking') : setup ? t('auth.createAccount') : t('auth.login')}{!action.busy && <ArrowRight />}</Button>
      </form>
    </Card>
    <p className="mt-7 text-xs text-muted-foreground">{t('auth.tagline')}</p>
    <Segmented className="mt-4" label={t('settings.language')} value={locale} onChange={setLocale} options={locales.map(value => ({ value, label: <span lang={value}>{localeNames[value]}</span> }))} />
  </div>;
}
