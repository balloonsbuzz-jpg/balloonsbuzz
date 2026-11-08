import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={location.state?.from || '/'} replace />;

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Could not sign in'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(circle_at_20%_10%,var(--bb-rose-100),transparent_45%),radial-gradient(circle_at_85%_90%,var(--bb-gold-100),transparent_40%)] px-4 py-10 dark:bg-none">
      <div className="w-full max-w-sm">
        <img src="/brand/logo.png" alt="BalloonsBuzz" className="mx-auto mb-6 h-20 w-auto" />
        <form onSubmit={onSubmit} className="rounded-2xl border bg-card p-6 shadow-[0_8px_30px_rgba(180,86,106,0.08)]" noValidate>
          <h1 className="text-xl font-extrabold">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">WhatsApp automation dashboard</p>

          <div className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={busy || !email || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground">Making Every Event Special 🎈</p>
      </div>
    </div>
  );
}
