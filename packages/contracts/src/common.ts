import { z } from 'zod';

export const UuidSchema = z.string().uuid();
export const EmailSchema = z.string().email().max(320);
export const SlugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case');
export const PermissionSchema = z.string().regex(/^[a-z]+[a-z0-9_]*\.[a-z]+[a-z0-9_]*$/);
export const UserPasswordSchema = z.string().min(12).max(128);