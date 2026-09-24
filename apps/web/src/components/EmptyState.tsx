import type { ReactNode } from 'react';

export interface EmptyStateProps {
  message: string;
  action?: ReactNode;
}

/** One line of text and, optionally, one action -- nothing more. */
export function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <div className="flex items-center gap-3 px-3 py-6 text-sm text-muted-foreground">
      <span>{message}</span>
      {action}
    </div>
  );
}
