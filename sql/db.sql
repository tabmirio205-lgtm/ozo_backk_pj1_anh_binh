-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.master_nodes (
  id bigint NOT NULL DEFAULT nextval('master_nodes_id_seq'::regclass),
  code text NOT NULL UNIQUE,
  stage text NOT NULL,
  name text NOT NULL,
  dept text,
  default_duration integer NOT NULL,
  default_after ARRAY DEFAULT '{}'::text[],
  description text,
  CONSTRAINT master_nodes_pkey PRIMARY KEY (id)
);
CREATE TABLE public.projects (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  type text NOT NULL,
  product_group text,
  owner text,
  start_date date NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  category text,
  CONSTRAINT projects_pkey PRIMARY KEY (id)
);
CREATE TABLE public.project_nodes (
  id bigint NOT NULL DEFAULT nextval('project_nodes_id_seq'::regclass),
  project_id bigint NOT NULL,
  node_id text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'Chưa làm'::text,
  pic text[] DEFAULT '{}'::text[],
  duration integer NOT NULL,
  actual_date date,
  notes text,
  dept text,
  after ARRAY DEFAULT '{}'::text[],
  attachments jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  planned_date date,
  CONSTRAINT project_nodes_pkey PRIMARY KEY (id),
  CONSTRAINT project_nodes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.app_users (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  email text UNIQUE,
  name text,
  role text NOT NULL DEFAULT 'employee'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_login_at timestamp with time zone,
  open_id text,
  CONSTRAINT app_users_pkey PRIMARY KEY (id)
);
CREATE TABLE public.login_codes (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  email text,
  code_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  open_id text,
  CONSTRAINT login_codes_pkey PRIMARY KEY (id)
);
CREATE TABLE public.pic_members (
  email text UNIQUE,
  pic_name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  dept text,
  is_leader boolean NOT NULL DEFAULT false,
  lead_depts ARRAY NOT NULL DEFAULT '{}'::text[],
  open_id text UNIQUE,
  phone text,
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  CONSTRAINT pic_members_pkey PRIMARY KEY (id)
);
CREATE TABLE public.chat_history (
  chat_id text NOT NULL,
  provider text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chat_history_pkey PRIMARY KEY (chat_id)
);
CREATE TABLE public.sent_reminders (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id bigint NOT NULL,
  node_id text NOT NULL,
  kind text NOT NULL,
  dedup_key text NOT NULL,
  pic text,
  email text,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT sent_reminders_pkey PRIMARY KEY (id)
);
CREATE TABLE public.chatbot_feedback (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  chat_id text NOT NULL,
  open_id text,
  pic_name text,
  question text NOT NULL,
  answer text NOT NULL,
  rating text,
  correction text,
  provider text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  rated_at timestamp with time zone,
  CONSTRAINT chatbot_feedback_pkey PRIMARY KEY (id)
);
CREATE TABLE public.chatbot_suggestions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  chat_id text NOT NULL,
  open_id text,
  pic_name text,
  message text NOT NULL,
  handled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_suggestions_pkey PRIMARY KEY (id)
);