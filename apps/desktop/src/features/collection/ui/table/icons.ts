import {
  Calendar,
  Check,
  Circle,
  Flag,
  Hash,
  Link,
  ListTree,
  Mail,
  Phone,
  Tag,
  Type,
  User,
  type LucideIcon,
} from "lucide-react";
import type { PropertyType } from "@/features/properties/model";

export const PROPERTY_TYPE_ICONS: Record<PropertyType, LucideIcon> = {
  text: Type,
  number: Hash,
  select: Circle,
  multi_select: Tag,
  status: Flag,
  date: Calendar,
  unique_id: Hash,
  actor: User,
  person: User,
  checkbox: Check,
  url: Link,
  email: Mail,
  phone: Phone,
  relation: ListTree,
};

export const TITLE_ICON = Type;
