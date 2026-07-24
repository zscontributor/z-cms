"use client";

import {
  ArrowClockwise,
  ArrowSquareOut,
  ArrowUUpLeft,
  ArrowUUpRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  Code,
  CodeBlock,
  Copy,
  DownloadSimple,
  Play,
  Envelope,
  Eraser,
  Eye,
  EyeSlash,
  FileText,
  Files,
  Folder,
  FolderPlus,
  Gear,
  Globe,
  Image as ImageIcon,
  Key,
  Link as LinkIcon,
  ListBullets,
  ListNumbers,
  MagnifyingGlass,
  Minus,
  Moon,
  Newspaper,
  Palette,
  PencilSimple,
  Plug,
  Plus,
  Prohibit,
  Quotes,
  SealCheck,
  ShieldCheck,
  ShieldWarning,
  SignOut,
  SquaresFour,
  Stack,
  Storefront,
  Sun,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  TextB,
  TextHThree,
  TextHTwo,
  TextItalic,
  TextStrikethrough,
  Trash,
  UploadSimple,
  UserCircle,
  Users,
  Warning,
  X,
  type Icon as PhosphorIcon,
  type IconWeight,
} from "@phosphor-icons/react";

/**
 * Every icon in the admin, resolved by name.
 *
 * Call sites pass a *string*, not a component, because some names are data: a
 * content type carries an `icon` field from the API, and the admin must be able
 * to draw it without knowing in advance which icons exist. That is what this
 * registry is for — and why an unknown name falls back to a document glyph
 * instead of throwing.
 *
 * Names are Phosphor's own kebab-case ones, so `icon: "newspaper"` in a content
 * type means the Phosphor icon called "newspaper". The short aliases below exist
 * for the fixed chrome (sidebar, buttons) where a shorter name reads better at
 * the call site.
 */
const REGISTRY: Record<string, PhosphorIcon> = {
  // Navigation and content
  grid: SquaresFour,
  "squares-four": SquaresFour,
  doc: FileText,
  "file-text": FileText,
  page: Files,
  files: Files,
  post: Newspaper,
  newspaper: Newspaper,
  image: ImageIcon,
  media: ImageIcon,
  palette: Palette,
  plug: Plug,
  settings: Gear,
  gear: Gear,
  language: Globe,
  globe: Globe,

  // Operations
  marketplace: Storefront,
  storefront: Storefront,
  publisher: SealCheck,
  sealCheck: SealCheck,
  jobs: Stack,
  stack: Stack,
  mail: Envelope,
  envelope: Envelope,
  users: Users,
  profile: UserCircle,

  // Actions
  plus: Plus,
  pencil: PencilSimple,
  edit: PencilSimple,
  folder: Folder,
  folderPlus: FolderPlus,
  trash: Trash,
  upload: UploadSimple,
  copy: Copy,
  check: Check,
  search: MagnifyingGlass,
  eye: Eye,
  eyeOff: EyeSlash,
  logout: SignOut,
  external: ArrowSquareOut,
  up: CaretUp,
  down: CaretDown,
  right: CaretRight,
  // The lightbox: dismiss, and step between screenshots.
  close: X,
  "chevron-left": CaretLeft,
  "chevron-right": CaretRight,
  play: Play,
  retry: ArrowClockwise,
  revoke: Prohibit,
  prohibit: Prohibit,
  key: Key,
  warning: Warning,
  shieldWarning: ShieldWarning,
  shield: ShieldCheck,
  install: DownloadSimple,

  // Theme switch
  sun: Sun,
  moon: Moon,

  // Rich-text toolbar
  bold: TextB,
  italic: TextItalic,
  strikethrough: TextStrikethrough,
  code: Code,
  codeBlock: CodeBlock,
  h2: TextHTwo,
  h3: TextHThree,
  bulletList: ListBullets,
  orderedList: ListNumbers,
  quote: Quotes,
  rule: Minus,
  link: LinkIcon,
  eraser: Eraser,
  undo: ArrowUUpLeft,
  redo: ArrowUUpRight,
  alignLeft: TextAlignLeft,
  alignCenter: TextAlignCenter,
  alignRight: TextAlignRight,
};

export type IconName = keyof typeof REGISTRY;

export function Icon({
  name,
  size = 20,
  weight = "regular",
  ...props
}: {
  name: string;
  size?: number;
  weight?: IconWeight;
  className?: string;
}) {
  const Glyph = REGISTRY[name] ?? FileText;
  return <Glyph size={size} weight={weight} aria-hidden {...props} />;
}
