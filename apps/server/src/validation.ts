import { z } from 'zod';

// Absolute target paths: POSIX (/srv), Windows drive (C:\ or C:/) and UNC (\\host\share).
export const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

// Execution accounts: POSIX login names, or Windows [DOMAIN\]name such as
// "PC-01\Jane Doe" and "NT AUTHORITY\SYSTEM".
const POSIX_USER = /^[A-Za-z_][A-Za-z0-9_.-]*[$]?$/;
const WINDOWS_USER = /^(?:[A-Za-z0-9 ._-]{1,64}\\)?[^\\/"[\]:;|=,+*?<>@\x00-\x1f]{1,104}$/;
export const executionUser = z.string().trim().max(170).refine(value => POSIX_USER.test(value) && value.length <= 64 || WINDOWS_USER.test(value), 'Invalid execution account');
