import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  children: ReactNode;
  size?: 'small' | 'medium';
  type?: 'button' | 'submit' | 'reset';
  variant?: 'primary' | 'secondary' | 'danger';
}

const VARIANT_CLASSES = {
  primary: 'bg-blue-600 text-white',
  secondary: 'border border-gray-300 bg-white text-gray-700',
  danger: 'bg-red-600 text-white',
} as const;

export function Button({ children, size = 'medium', variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`rounded-md disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${
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