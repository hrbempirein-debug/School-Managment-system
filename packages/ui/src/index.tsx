import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  children: ReactNode;
  size?: 'small' | 'medium';
  type?: 'button' | 'submit' | 'reset';
}

export function Button({ children, size = 'medium', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`rounded-md bg-blue-600 text-white disabled:opacity-50 ${
        size === 'small' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2'
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-gray-200 bg-white p-6 shadow-sm ${className}`}>
      {children}
    </div>
  );
}