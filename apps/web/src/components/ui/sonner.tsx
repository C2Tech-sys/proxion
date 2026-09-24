import { Toaster as Sonner, type ToasterProps } from 'sonner';

import { useUiStore } from '@/store/ui';

function Toaster(props: ToasterProps) {
  const theme = useUiStore((s) => s.theme);

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group toast bg-popover! text-popover-foreground! border-border! shadow-lg! text-sm!',
          description: 'text-muted-foreground!',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
