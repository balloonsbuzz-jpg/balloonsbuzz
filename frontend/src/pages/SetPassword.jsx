import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle } from '@phosphor-icons/react';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Opened from an invite or reset link: /set-password?token=… (no sign-in needed). */
export default function SetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const link = useQuery({
    queryKey: ['link', token],
    queryFn: async () => (await api.get(`/auth/link/${encodeURIComponent(token)}`)).data,
    retry: false, enabled: !!token, staleTime: Infinity,
  });
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const save = useMutation({ mutationFn: async () => (await api.post(`/auth/link/${encodeURIComponent(token)}`, { password: pw })).data });
  const mismatch = pw2 && pw !== pw2;

  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(circle_at_20%_10%,var(--bb-rose-100),transparent_45%),radial-gradient(circle_at_85%_90%,var(--bb-gold-100),transparent_40%)] px-4 py-10 dark:bg-none">
      <div className="w-full max-w-sm">
        <img src="/brand/logo.png" alt="BalloonsBuzz" className="mx-auto mb-6 h-20 w-auto" />
        <div className="rounded-2xl border bg-card p-6 shadow-[0_8px_30px_rgba(180,86,106,0.08)]">
          {(!token || link.isError) && (
            <>
              <h1 className="text-xl font-extrabold">This link doesn’t work</h1>
              <p className="mt-2 text-sm text-muted-foreground">{token ? errorMessage(link.error) : 'The link is incomplete.'} Links work once and expire after a few days.</p>
              <Button className="mt-5 w-full" variant="outline" nativeButton={false} render={<Link to="/login" />}>Go to sign in</Button>
            </>
          )}
          {token && link.isLoading && <p className="text-sm text-muted-foreground">Checking the link…</p>}
          {link.data && save.isSuccess && (
            <div className="text-center">
              <CheckCircle size={44} weight="fill" className="mx-auto text-success" />
              <h1 className="mt-2 text-xl font-extrabold">Password set</h1>
              <p className="mt-1 text-sm text-muted-foreground">Sign in with {link.data.email} and your new password.</p>
              <Button className="mt-5 w-full" nativeButton={false} render={<Link to="/login" />}>Sign in</Button>
            </div>
          )}
          {link.data && !save.isSuccess && (
            <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} noValidate>
              <h1 className="text-xl font-extrabold">{link.data.purpose === 'invite' ? `Welcome, ${link.data.full_name.split(' ')[0]}` : 'Choose a new password'}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {link.data.purpose === 'invite' ? 'Choose a password for the BalloonsBuzz dashboard.' : `For ${link.data.email}.`} You’ll sign in with <b>{link.data.email}</b>.
              </p>
              <input type="email" autoComplete="username" value={link.data.email} readOnly hidden />
              <div className="mt-5 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="pw">New password</Label>
                  <Input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus aria-describedby="pw-hint" />
                  <p id="pw-hint" className="text-xs text-muted-foreground">At least 10 characters. A short sentence is easy to remember.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pw2">Type it again</Label>
                  <Input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={!!mismatch} />
                  {mismatch && <p className="text-xs text-destructive">The two passwords are different.</p>}
                </div>
                {save.error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{errorMessage(save.error)}</p>}
                <Button type="submit" size="lg" className="w-full" disabled={save.isPending || pw.length < 10 || pw !== pw2}>
                  {save.isPending ? 'Saving…' : 'Set password'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
