import { createRootRoute, Outlet } from '@tanstack/react-router';

import { Toaster } from '@/components/ui/sonner';
import { CommandPalette } from '@/components/CommandPalette';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <Outlet />
      <CommandPalette />
      <Toaster />
    </div>
  );
}
