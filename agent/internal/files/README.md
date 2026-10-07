# File RPC behavior

`Handle(method string, params json.RawMessage) (any, error)` implements the
`file.*` methods in `docs/protocol.md`. It does not change credentials. Paths must
be absolute, and access is governed by the process's OS account.
Read, write, and edit operate on regular files; special files such as FIFOs are
rejected before opening, so an RPC does not wait for an unrelated pipe peer.

`Transfers` handles `file.transfer.*` in the owning runner generation. It streams
512 KiB chunks with byte offsets and SHA-256 verification. Uploads use a
temporary file in the destination directory and publish atomically after commit;
existing destinations are protected by default. A new file gets 0666 less the
umask; an overwrite keeps the replaced file's mode (and owner, for a root runner). Download sessions pin a regular
file descriptor and reject changes to its size or modification time. Active
sessions keep their runner in use across agent updates. Idle sessions expire
after 15 minutes; recorded upload temporaries are also removed on runner restart.
These sessions do not automatically resume after a central or runner restart.

- `file.list` returns lexical entry order, `file` / `directory` / `symlink` /
  `other` types, numeric Unix permission bits, and UTC modification timestamps.
- `file.read` uses byte offsets, base64 data, and a default 64 KiB raw chunk. A
  larger requested limit is clamped to 512 KiB so the JSON response stays below
  1 MiB. A zero limit selects the default; a negative offset or limit is invalid.
- `file.image` reads one complete regular PNG/JPEG file under the same OS
  permissions. It identifies contents, checks dimensions before decoding, and
  returns unchanged base64 bytes, MIME type, size, width and height. The limits
  are 8 MiB and 24 million pixels. Invalid paths, missing/denied files, invalid
  image data and excessive size have distinct RPC codes with corrective hints.
  It performs all validation in this one RPC and never modifies the image.
- `file.write` defaults to UTF-8. Base64 is validated before opening the file.
  `createOnly` uses exclusive creation, including when the existing path is a
  symlink. Ordinary writes follow symlinks and preserve existing file modes.
- `file.edit` requires one occurrence, including overlapping occurrences, of a
  non-empty `oldText`. It follows the target inode and preserves its mode, owner,
  hard links, and symlink identity. Edits are ordinary in-place writes; concurrent
  external writers and crashes during a write are not an atomic transaction.
- `file.delete` follows normal unlink semantics. Recursive deletion removes a
  directory symlink itself, without deleting the directory it points to.
- `file.search` is case-sensitive literal search, with one result per matching
  line. Queries must be non-empty, contain no NUL, and fit on one line. Line
  numbers start at 1. It scans complete lines of any length using a bounded
  buffer. `text` is a UTF-8 prefix preview of at most 512 source bytes, excluding
  the line ending; `truncated:true` means the line continues beyond the preview
  and the match may be beyond the displayed prefix. NUL in the first 8 KiB
  identifies binary files to skip. Search defaults to 100 results and clamps to
  1000 results and a 1 MiB JSON response budget. Offset counts matching lines;
  `nextOffset` continues the deterministic lexical traversal, and `eof` means
  no additional matching line was found. Pagination assumes files are unchanged
  between calls. An explicit root symlink is followed, file symlinks are read,
  and encountered directory symlinks are not traversed. Other non-regular files
  are skipped. Inaccessible files return an OS error, rather than a silently
  incomplete successful result.
