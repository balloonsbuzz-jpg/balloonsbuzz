import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';

export default function ChangePasswordDialog({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const save = useMutation({
    mutationFn: async () => (await api.post('/auth/password', { current_password: current, new_password: next })).data,
    onSuccess: () => { toast.success('Password changed. Other devices were signed out.'); onClose(); },
  });
  const mismatch = again && next !== again;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Change your password</DialogTitle>
            <DialogDescription>You stay signed in here; other phones and computers are signed out.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5"><Label htmlFor="cp-cur">Current password</Label><Input id="cp-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus /></div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-new">New password</Label>
            <Input id="cp-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            <p className="text-xs text-muted-foreground">At least 10 characters.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-again">Type it again</Label>
            <Input id="cp-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={!!mismatch} />
            {mismatch && <p className="text-xs text-destructive">The two passwords are different.</p>}
          </div>
          {save.error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{errorMessage(save.error)}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || !current || next.length < 10 || next !== again}>Change password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
