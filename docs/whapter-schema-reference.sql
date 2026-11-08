--
-- PostgreSQL database dump
--

-- Dumped from database version 15.4 (Debian 15.4-2.pgdg120+1)
-- Dumped by pg_dump version 15.4 (Debian 15.4-2.pgdg120+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: call_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.call_job_status AS ENUM (
    'pending',
    'queued',
    'ringing',
    'connected',
    'completed',
    'failed',
    'no_answer',
    'busy',
    'rejected',
    'cancelled'
);


--
-- Name: campaign_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.campaign_status AS ENUM (
    'draft',
    'active',
    'paused',
    'completed',
    'cancelled'
);


--
-- Name: tenant_id(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.tenant_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::json->>'tenant_id')::uuid;
$$;


--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::json->>'id',
    NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub'
  )::uuid;
$$;


--
-- Name: crm_update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: debug_jwt_claims(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.debug_jwt_claims() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT current_setting('request.jwt.claims', true);
$$;


--
-- Name: debug_uid(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.debug_uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT auth.uid();
$$;


--
-- Name: get_instagram_inbox_conversations(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_instagram_inbox_conversations(p_tenant_id text, p_ig_account_id text) RETURNS TABLE(id text, commenter_id text, username text, ig_account_id text, last_message text, last_sent_at timestamp with time zone, unread_count bigint, direction text)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  WITH ranked_messages AS (
    SELECT 
      l.commenter_id,
      l.commenter_username,
      l.ig_account_id,
      COALESCE(NULLIF(l.dm_text, ''), CASE WHEN l.media_url IS NOT NULL THEN '[Attachment]' ELSE '' END) AS msg_text,
      l.sent_at,
      l.direction,
      ROW_NUMBER() OVER (PARTITION BY l.commenter_id ORDER BY l.sent_at DESC) as rn
    FROM instagram_dm_logs l
    WHERE (l.tenant_id = p_tenant_id OR (l.tenant_id IS NULL AND (p_tenant_id = 'default' OR p_tenant_id IS NULL)))
      AND l.ig_account_id = p_ig_account_id
      AND (l.is_deleted IS NULL OR l.is_deleted = false)
      AND (l.post_id IS NULL OR l.post_id != 'SYSTEM_EVENT')
      AND l.commenter_id != p_ig_account_id
  ),
  unread_counts AS (
    SELECT 
      l.commenter_id,
      COUNT(*) AS unread
    FROM instagram_dm_logs l
    WHERE (l.tenant_id = p_tenant_id OR (l.tenant_id IS NULL AND (p_tenant_id = 'default' OR p_tenant_id IS NULL)))
      AND l.ig_account_id = p_ig_account_id
      AND l.direction = 'inbound'
      AND (l.is_read IS NULL OR l.is_read = false)
      AND (l.is_deleted IS NULL OR l.is_deleted = false)
      AND (l.post_id IS NULL OR l.post_id != 'SYSTEM_EVENT')
      AND l.commenter_id != p_ig_account_id
    GROUP BY l.commenter_id
  )
  SELECT 
    r.commenter_id::TEXT AS id,
    r.commenter_id::TEXT AS commenter_id,
    COALESCE(r.commenter_username, 'ig_user')::TEXT AS username,
    r.ig_account_id::TEXT AS ig_account_id,
    r.msg_text::TEXT AS last_message,
    r.sent_at AS last_sent_at,
    COALESCE(u.unread, 0)::BIGINT AS unread_count,
    COALESCE(r.direction, 'outbound')::TEXT AS direction
  FROM ranked_messages r
  LEFT JOIN unread_counts u ON u.commenter_id = r.commenter_id
  WHERE r.rn = 1
  ORDER BY r.sent_at DESC;
END;
$$;


--
-- Name: increment_automation_execution_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_automation_execution_count(p_automation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.crm_automations
  SET execution_count = COALESCE(execution_count, 0) + 1,
      last_executed_at = now()
  WHERE id = p_automation_id;
END;
$$;


--
-- Name: increment_broadcast_status(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_broadcast_status(p_broadcast_id uuid, p_status text, p_increment integer DEFAULT 1) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
BEGIN
  -- Validate the status to prevent SQL injection or invalid column updates
  IF p_status NOT IN ('sent', 'delivered', 'read', 'replied', 'failed') THEN
    RAISE EXCEPTION 'Invalid status for broadcast increment: %', p_status;
  END IF;

  -- Execute the dynamic atomic increment
  EXECUTE format('
    UPDATE public.crm_broadcasts 
    SET %I = COALESCE(%I, 0) + $1 
    WHERE id = $2
  ', p_status || '_count', p_status || '_count')
  USING p_increment, p_broadcast_id;
END;
$_$;


--
-- Name: increment_campaign_status(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_campaign_status(p_campaign_id uuid, p_status text, p_increment integer DEFAULT 1) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
BEGIN
  -- Validate the status to prevent SQL injection or invalid column updates
  IF p_status NOT IN ('delivered', 'read', 'failed', 'replied') THEN
    RAISE EXCEPTION 'Invalid status for campaign increment: %', p_status;
  END IF;

  -- Execute the dynamic atomic increment
  EXECUTE format('
    UPDATE public.campaigns 
    SET %I = COALESCE(%I, 0) + $1 
    WHERE id = $2
  ', p_status, p_status)
  USING p_increment, p_campaign_id;
END;
$_$;


--
-- Name: increment_flow_execution_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_flow_execution_count(p_flow_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.crm_flows
  SET execution_count = COALESCE(execution_count, 0) + 1,
      last_executed_at = now()
  WHERE id = p_flow_id;
END;
$$;


--
-- Name: increment_voice_flow_execution_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_voice_flow_execution_count(p_flow_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
  UPDATE voice_flows SET execution_count = execution_count + 1 WHERE id = p_flow_id;
$$;


--
-- Name: FUNCTION increment_voice_flow_execution_count(p_flow_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.increment_voice_flow_execution_count(p_flow_id uuid) IS 'SECURITY DEFINER RPC: increments voice_flows.execution_count on each new run.';


--
-- Name: match_action_assets(public.vector, uuid, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_action_assets(query_embedding public.vector, p_tenant_id uuid, match_threshold double precision, match_count integer) RETURNS TABLE(id uuid, tenant_id uuid, title text, description text, tags text[], alt_text text, language text, mime_type text, asset_url text, thumbnail_url text, caption text, metadata jsonb, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
      SELECT
        agent_action_assets.id,
        agent_action_assets.tenant_id,
        agent_action_assets.title,
        agent_action_assets.description,
        agent_action_assets.tags,
        agent_action_assets.alt_text,
        agent_action_assets.language,
        agent_action_assets.mime_type,
        agent_action_assets.asset_url,
        agent_action_assets.thumbnail_url,
        agent_action_assets.caption,
        agent_action_assets.metadata,
        (1 - (agent_action_assets.embedding_v2 <=> query_embedding))::float AS similarity
      FROM agent_action_assets
      WHERE agent_action_assets.tenant_id = p_tenant_id
        AND (1 - (agent_action_assets.embedding_v2 <=> query_embedding)) > match_threshold
      ORDER BY agent_action_assets.embedding_v2 <=> query_embedding
      LIMIT match_count;
    $$;


--
-- Name: match_action_assets_v2(public.vector, uuid, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_action_assets_v2(query_embedding public.vector, p_tenant_id uuid, match_threshold double precision, match_count integer) RETURNS TABLE(id uuid, tenant_id uuid, title text, description text, tags text[], alt_text text, language text, mime_type text, asset_url text, thumbnail_url text, caption text, metadata jsonb, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    agent_action_assets.id,
    agent_action_assets.tenant_id,
    agent_action_assets.title,
    agent_action_assets.description,
    agent_action_assets.tags,
    agent_action_assets.alt_text,
    agent_action_assets.language,
    agent_action_assets.mime_type,
    agent_action_assets.asset_url,
    agent_action_assets.thumbnail_url,
    agent_action_assets.caption,
    agent_action_assets.metadata,
    (1 - (agent_action_assets.embedding_v2 <=> query_embedding))::float AS similarity
  FROM agent_action_assets
  WHERE agent_action_assets.tenant_id = p_tenant_id
    AND (1 - (agent_action_assets.embedding_v2 <=> query_embedding)) > match_threshold
  ORDER BY agent_action_assets.embedding_v2 <=> query_embedding
  LIMIT match_count;
$$;


--
-- Name: match_agent_actions(public.vector, uuid, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_agent_actions(query_embedding public.vector, p_tenant_id uuid, match_threshold double precision, match_count integer) RETURNS TABLE(id uuid, tenant_id uuid, name text, description text, parameters jsonb, action_type text, example_prompts text[], category text, icon text, status text, version integer, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    agent_tools.id,
    agent_tools.tenant_id,
    agent_tools.name,
    agent_tools.description,
    agent_tools.parameters,
    agent_tools.action_type,
    agent_tools.example_prompts,
    agent_tools.category,
    agent_tools.icon,
    agent_tools.status,
    agent_tools.version,
    (1 - (agent_tools.description_embedding <=> query_embedding))::float AS similarity
  FROM agent_tools
  WHERE agent_tools.tenant_id = p_tenant_id
    AND agent_tools.is_enabled = TRUE
    AND agent_tools.status = 'published'
    AND (1 - (agent_tools.description_embedding <=> query_embedding)) > match_threshold
  ORDER BY agent_tools.description_embedding <=> query_embedding
  LIMIT match_count;
$$;


--
-- Name: match_agent_actions_v2(public.vector, uuid, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_agent_actions_v2(query_embedding public.vector, p_tenant_id uuid, match_threshold double precision, match_count integer) RETURNS TABLE(id uuid, tenant_id uuid, name text, description text, parameters jsonb, action_type text, example_prompts text[], category text, icon text, status text, version integer, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    agent_tools.id,
    agent_tools.tenant_id,
    agent_tools.name,
    agent_tools.description,
    agent_tools.parameters,
    agent_tools.action_type,
    agent_tools.example_prompts,
    agent_tools.category,
    agent_tools.icon,
    agent_tools.status,
    agent_tools.version,
    (1 - (agent_tools.embedding_v2 <=> query_embedding))::float AS similarity
  FROM agent_tools
  WHERE agent_tools.tenant_id = p_tenant_id
    AND agent_tools.is_enabled = TRUE
    AND agent_tools.status = 'published'
    AND (1 - (agent_tools.embedding_v2 <=> query_embedding)) > match_threshold
  ORDER BY agent_tools.embedding_v2 <=> query_embedding
  LIMIT match_count;
$$;


--
-- Name: match_knowledge_chunks(public.vector, uuid, double precision, integer, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_knowledge_chunks(query_embedding public.vector, p_tenant_id uuid, match_threshold double precision, match_count integer, p_document_ids uuid[] DEFAULT NULL::uuid[]) RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.document_id,
    kc.content,
    (1 - (kc.embedding <=> query_embedding))::float AS similarity
  FROM knowledge_chunks kc
  JOIN knowledge_documents kd ON kc.document_id = kd.id
  WHERE kc.tenant_id = p_tenant_id
    AND kd.status = 'ready'
    AND (p_document_ids IS NULL OR kc.document_id = ANY(p_document_ids))
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: match_knowledge_chunks_v2(public.vector, uuid, double precision, integer, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_knowledge_chunks_v2(query_embedding public.vector, p_tenant_id uuid, match_threshold double precision, match_count integer, p_document_ids uuid[] DEFAULT NULL::uuid[]) RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.document_id,
    kc.content,
    (1 - (kc.embedding_v2 <=> query_embedding))::float AS similarity
  FROM knowledge_chunks kc
  JOIN knowledge_documents kd ON kc.document_id = kd.id
  WHERE kc.tenant_id = p_tenant_id
    AND kd.status = 'ready'
    AND (p_document_ids IS NULL OR kc.document_id = ANY(p_document_ids))
    AND 1 - (kc.embedding_v2 <=> query_embedding) > match_threshold
  ORDER BY kc.embedding_v2 <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: pg_normalize_phone(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pg_normalize_phone(phone text, default_country text DEFAULT '91'::text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  cleaned text;
  has_plus boolean;
BEGIN
  IF phone IS NULL THEN
    RETURN NULL;
  END IF;
  phone := trim(phone);
  IF phone = '' THEN
    RETURN NULL;
  END IF;
  has_plus := starts_with(phone, '+');
  cleaned := regexp_replace(phone, '[^\d]', '', 'g');
  cleaned := regexp_replace(cleaned, '^0+', '');
  IF length(cleaned) < 7 OR length(cleaned) > 15 THEN
    RETURN NULL;
  END IF;
  IF length(cleaned) = 10 THEN
    cleaned := default_country || cleaned;
    RETURN '+' || cleaned;
  END IF;
  IF has_plus THEN
    RETURN '+' || cleaned;
  END IF;
  RETURN '+' || cleaned;
END;
$$;


--
-- Name: sync_crm_contact_to_sales_crm(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_crm_contact_to_sales_crm() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_source TEXT;
  v_project TEXT;
  v_parts TEXT[];
BEGIN
  -- Determine source and project from source_metadata or source column
  IF NEW.source_metadata IS NOT NULL AND NEW.source_metadata->>'final_source' IS NOT NULL THEN
    v_parts := string_to_array(NEW.source_metadata->>'final_source', ' - ');
    v_source := v_parts[1];
    IF array_length(v_parts, 1) >= 2 THEN
      v_project := v_parts[2];
    END IF;
  ELSIF NEW.source = 'webhook' AND NEW.source_metadata->>'source' IS NOT NULL THEN
    v_source := NEW.source_metadata->>'source';
    v_project := NEW.source_metadata->>'routing_key';
  ELSE
    v_source := COALESCE(NEW.source, 'Manual');
    v_project := NULL;
  END IF;

  -- Clean up base source mapping
  IF v_source = 'Facebook Ads' THEN
    v_source := 'Meta Ads';
  END IF;

  -- Upsert into sales_crm_leads
  INSERT INTO public.sales_crm_leads (
    user_id,
    customer_name,
    customer_phone,
    customer_email,
    source,
    project,
    contact_status,
    qualification_status,
    site_visit_status,
    created_at,
    updated_at
  ) VALUES (
    NEW.user_id,
    COALESCE(NEW.name, ''),
    NEW.phone,
    NEW.email,
    COALESCE(v_source, 'Manual'),
    v_project,
    'Not Contacted',
    'Pending',
    'Not Scheduled',
    COALESCE(NEW.created_at, NOW()),
    COALESCE(NEW.updated_at, NOW())
  )
  ON CONFLICT (user_id, customer_phone)
  DO UPDATE SET
    customer_name = COALESCE(EXCLUDED.customer_name, sales_crm_leads.customer_name),
    customer_email = COALESCE(EXCLUDED.customer_email, sales_crm_leads.customer_email),
    source = COALESCE(EXCLUDED.source, sales_crm_leads.source),
    project = COALESCE(EXCLUDED.project, sales_crm_leads.project),
    updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END;
$$;


--
-- Name: sync_whatsapp_message_to_crm(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_whatsapp_message_to_crm() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  normalized_phone text;
  contact_uuid uuid;
  conversation_uuid uuid;
  current_unread integer;
  content_text text;
  media_url text;
  last_msg_text text;
  new_unread integer;
  c jsonb;
BEGIN
  -- Determine remote number (inbound: from_number, outbound: to_number)
  IF NEW.direction = 'inbound' THEN
    normalized_phone := pg_normalize_phone(NEW.from_number);
  ELSE
    normalized_phone := pg_normalize_phone(NEW.to_number);
  END IF;

  IF normalized_phone IS NULL THEN
    RETURN NEW;
  END IF;

  -- A. Find or create CRM Contact
  SELECT id INTO contact_uuid FROM crm_contacts 
  WHERE user_id = NEW.tenant_id AND phone = normalized_phone;

  IF contact_uuid IS NULL THEN
    DECLARE
      contact_name text;
    BEGIN
      contact_name := NEW.content->'contacts'->0->'profile'->>'name';
      IF contact_name IS NULL OR contact_name = '' THEN
        contact_name := normalized_phone;
      END IF;

      INSERT INTO crm_contacts(user_id, phone, name)
      VALUES (NEW.tenant_id, normalized_phone, contact_name)
      RETURNING id INTO contact_uuid;
    END;
  END IF;

  -- B. Parse WhatsApp content to plain text and media URLs
  c := NEW.content;
  IF NEW.message_type = 'text' THEN
    content_text := c->'text'->>'body';
  ELSIF NEW.message_type = 'interactive' THEN
    content_text := coalesce(
      c->'interactive'->'button_reply'->>'title',
      c->'interactive'->'list_reply'->>'title',
      c->'interactive'->'body'->>'text',
      ''
    );
  ELSIF NEW.message_type = 'button' THEN
    content_text := c->'button'->>'text';
  ELSIF NEW.message_type IN ('image', 'video', 'audio', 'document', 'sticker') THEN
    content_text := coalesce(
      c->NEW.message_type->>'caption',
      c->>'caption'
    );
    IF NEW.message_type = 'document' AND content_text IS NULL THEN
      content_text := coalesce(
        c->'document'->>'filename',
        c->>'filename'
      );
    END IF;
    IF c->NEW.message_type->>'id' IS NOT NULL THEN
      media_url := '/api/whatsapp/media/' || (c->NEW.message_type->>'id');
    ELSIF c->NEW.message_type->>'link' IS NOT NULL THEN
      media_url := c->NEW.message_type->>'link';
    ELSIF c->>'link' IS NOT NULL THEN
      media_url := c->>'link';
    ELSIF c->>'mediaUrl' IS NOT NULL THEN
      media_url := c->>'mediaUrl';
    END IF;
  ELSIF NEW.message_type = 'template' THEN
    content_text := c->>'rendered_body';
    IF c->>'header_url' IS NOT NULL THEN
      media_url := c->>'header_url';
    END IF;
  ELSIF NEW.message_type = 'order' THEN
    DECLARE
      item_list text := '';
      item_rec record;
      order_text text;
    BEGIN
      order_text := c->'order'->>'text';
      FOR item_rec IN 
        SELECT 
          (val->>'quantity')::int as qty, 
          coalesce(val->>'product_name', val->>'product_retailer_id') as sku, 
          val->>'item_price' as price
        FROM jsonb_array_elements(c->'order'->'product_items') as val
      LOOP
        item_list := item_list || item_rec.qty || 'x ' || item_rec.sku || ' (₹' || item_rec.price || '), ';
      END LOOP;
      IF length(item_list) > 2 THEN
        item_list := rtrim(item_list, ', ');
      ELSE
        item_list := 'Empty cart';
      END IF;
      
      IF order_text IS NOT NULL AND order_text <> '' THEN
        content_text := item_list || E'\n\nMessage: ' || order_text;
      ELSE
        content_text := item_list;
      END IF;
    END;
  END IF;

  last_msg_text := coalesce(content_text, '[' || NEW.message_type || ']');

  -- C. Find or create CRM Conversation
  SELECT id, unread_count INTO conversation_uuid, current_unread FROM crm_conversations
  WHERE user_id = NEW.tenant_id AND contact_id = contact_uuid;

  new_unread := coalesce(current_unread, 0);
  IF NEW.direction = 'inbound' AND NEW.status = 'received' THEN
    new_unread := new_unread + 1;
  END IF;

  IF conversation_uuid IS NULL THEN
    INSERT INTO crm_conversations(
      user_id,
      contact_id,
      status,
      unread_count,
      last_message_text,
      last_message_at
    )
    VALUES (
      NEW.tenant_id,
      contact_uuid,
      'open',
      new_unread,
      last_msg_text,
      NEW.timestamp
    )
    RETURNING id INTO conversation_uuid;
  ELSE
    UPDATE crm_conversations
    SET status = CASE WHEN status = 'needs_human' THEN 'needs_human'::text ELSE 'open'::text END,
        unread_count = new_unread,
        last_message_text = last_msg_text,
        last_message_at = NEW.timestamp,
        updated_at = now()
    WHERE id = conversation_uuid;
  END IF;

  -- D. Insert the message into crm_messages if it does not already exist
  IF NEW.wa_message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_messages WHERE message_id = NEW.wa_message_id) THEN
    INSERT INTO crm_messages(
      conversation_id,
      sender_type,
      content_type,
      content_text,
      media_url,
      message_id,
      status,
      created_at
    )
    VALUES (
      conversation_uuid,
      CASE WHEN NEW.direction = 'inbound' THEN 'customer'::text ELSE 'agent'::text END,
      CASE 
        WHEN NEW.message_type = 'button' THEN 'interactive'::text
        WHEN NEW.message_type = 'sticker' THEN 'image'::text
        WHEN NEW.message_type = 'contacts' THEN 'text'::text
        WHEN NEW.message_type = 'poll_vote' THEN 'text'::text
        WHEN NEW.message_type = 'poll' THEN 'text'::text
        WHEN NEW.message_type = 'order' THEN 'text'::text
        WHEN NEW.message_type IN ('text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive') THEN NEW.message_type
        ELSE 'text'::text
      END,
      content_text,
      media_url,
      NEW.wa_message_id,
      CASE WHEN NEW.status = 'received' THEN 'delivered'::text ELSE NEW.status END,
      NEW.timestamp
    );
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: sync_whatsapp_status_to_crm(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_whatsapp_status_to_crm() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.error_message IS DISTINCT FROM OLD.error_message THEN
    UPDATE crm_messages
    SET status = CASE WHEN NEW.status = 'received' THEN 'delivered'::text ELSE NEW.status END,
        error_message = NEW.error_message
    WHERE message_id = NEW.wa_message_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: update_push_subscription_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_push_subscription_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: voice_agent_profiles_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_agent_profiles_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: voice_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.voice_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: active_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_calls (
    room_id text NOT NULL,
    phone text,
    caller_name text,
    status text DEFAULT 'ringing'::text,
    started_at timestamp with time zone DEFAULT now(),
    last_updated timestamp with time zone DEFAULT now()
);


--
-- Name: active_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    telecaller_id uuid NOT NULL,
    caller_phone text DEFAULT 'UNKNOWN'::text NOT NULL,
    caller_name text,
    custom_variables jsonb DEFAULT '{}'::jsonb,
    omnidim_call_id text,
    transcript text,
    summary text,
    extracted_variables jsonb,
    sentiment text,
    status text DEFAULT 'RINGING'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    CONSTRAINT active_transfers_status_check CHECK ((status = ANY (ARRAY['RINGING'::text, 'CONNECTED'::text, 'COMPLETED'::text, 'MISSED'::text])))
);


--
-- Name: admin_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    action text NOT NULL,
    target_user_id uuid,
    details jsonb,
    ip_address text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: agent_action_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_action_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    tags text[] DEFAULT '{}'::text[],
    alt_text text,
    language character varying(10) DEFAULT 'en'::character varying,
    mime_type character varying(100) NOT NULL,
    asset_url text NOT NULL,
    thumbnail_url text,
    caption text,
    metadata jsonb DEFAULT '{}'::jsonb,
    embedding public.vector(384),
    created_at timestamp with time zone DEFAULT now(),
    embedding_v2 public.vector(1024),
    embedding_model text DEFAULT 'minilm-l6-v2'::text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: agent_tool_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tool_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tool_id uuid NOT NULL,
    asset_name text NOT NULL,
    asset_url text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_custom boolean DEFAULT false NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    action_type character varying(50) DEFAULT 'database'::character varying,
    example_prompts text[] DEFAULT '{}'::text[],
    category character varying(100),
    icon character varying(100),
    status character varying(20) DEFAULT 'published'::character varying,
    version integer DEFAULT 1,
    version_parent_id uuid,
    description_embedding public.vector(384),
    execution_type text DEFAULT 'internal_action'::text,
    endpoint_url text,
    http_method text DEFAULT 'POST'::text,
    headers_enc text,
    response_type text DEFAULT 'auto'::text,
    embedding_v2 public.vector(1024),
    embedding_model text DEFAULT 'minilm-l6-v2'::text
);


--
-- Name: ai_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    supported_models jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ai_usage_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    tokens_prompt integer DEFAULT 0,
    tokens_completion integer DEFAULT 0,
    estimated_cost numeric(10,6) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    estimated_cost_inr numeric(10,6) DEFAULT 0,
    tokens_prompt_cached integer DEFAULT 0,
    tokens_prompt_uncached integer DEFAULT 0
);


--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: blog_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blog_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: blog_post_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blog_post_categories (
    post_id uuid NOT NULL,
    category_id uuid NOT NULL
);


--
-- Name: blog_post_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blog_post_tags (
    post_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: blog_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blog_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    excerpt text,
    content jsonb,
    content_html text,
    cover_image_url text,
    status text DEFAULT 'draft'::text,
    is_featured boolean DEFAULT false,
    seo_title text,
    seo_description text,
    og_image_url text,
    reading_time_minutes integer DEFAULT 1,
    view_count integer DEFAULT 0,
    author_id uuid,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT blog_posts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);


--
-- Name: blog_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blog_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: call_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    room_id character varying(255),
    caller_number character varying(50),
    duration_seconds integer,
    cost_inr numeric(12,2),
    status character varying(30),
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    metadata jsonb,
    phone_number character varying(50),
    estimated_cost_usd numeric(12,2),
    recording_url text,
    summary text,
    created_at timestamp with time zone DEFAULT now(),
    campaign_id uuid,
    CONSTRAINT ck_call_logs_status CHECK (((status)::text = ANY (ARRAY[('ringing'::character varying)::text, ('in_progress'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('no_answer'::character varying)::text, ('no_charge'::character varying)::text])))
);


--
-- Name: call_transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_transcripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    call_room_id text NOT NULL,
    phone text,
    role text,
    content text,
    created_at timestamp with time zone DEFAULT now(),
    tenant_id uuid,
    call_job_id uuid,
    sequence_num integer DEFAULT 0,
    CONSTRAINT call_transcripts_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: campaign_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    phone text NOT NULL,
    variables jsonb DEFAULT '[]'::jsonb,
    status text DEFAULT 'pending'::text,
    wa_message_id text,
    error_message text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT campaign_recipients_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text, 'replied'::text])))
);


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    channel text DEFAULT 'whatsapp'::text,
    status text DEFAULT 'draft'::text,
    sent integer DEFAULT 0,
    delivered integer DEFAULT 0,
    read integer DEFAULT 0,
    replied integer DEFAULT 0,
    failed integer DEFAULT 0,
    scheduled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    template_name text,
    language_code text DEFAULT 'en_US'::text,
    total_recipients integer DEFAULT 0,
    deleted_at timestamp with time zone,
    error_message text,
    CONSTRAINT campaigns_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'sms'::text, 'api'::text]))),
    CONSTRAINT campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'active'::text])))
);


--
-- Name: chat_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    agent_user_id uuid,
    assigned_at timestamp with time zone DEFAULT now()
);


--
-- Name: chat_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contact_id text NOT NULL,
    status text DEFAULT 'bot_active'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    conversation_summary text,
    last_summarized_at_count integer DEFAULT 0,
    CONSTRAINT chat_conversations_status_check CHECK ((status = ANY (ARRAY['bot_active'::text, 'human_escalated'::text, 'resolved'::text])))
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    tokens_used integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    media jsonb,
    CONSTRAINT chat_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text, 'human_agent'::text])))
);


--
-- Name: chatbot_corpus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chatbot_corpus (
    id bigint NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    text text NOT NULL,
    embedding public.vector
);


--
-- Name: chatbot_corpus_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chatbot_corpus_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chatbot_corpus_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chatbot_corpus_id_seq OWNED BY public.chatbot_corpus.id;


--
-- Name: crm_account_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_account_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    role text DEFAULT 'agent'::text NOT NULL,
    token_hash text NOT NULL,
    created_by_user_id uuid,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by_user_id uuid,
    CONSTRAINT crm_account_invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'agent'::text, 'viewer'::text])))
);


--
-- Name: crm_account_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_account_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'agent'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_account_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text, 'viewer'::text])))
);


--
-- Name: crm_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    owner_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_automation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_automation_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    contact_id uuid,
    trigger_event text NOT NULL,
    steps_executed jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_automation_logs_status_check CHECK ((status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: crm_automation_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_automation_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    node_key text NOT NULL,
    node_type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    position_x integer DEFAULT 0 NOT NULL,
    position_y integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    trigger_type text NOT NULL,
    trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    execution_count integer DEFAULT 0 NOT NULL,
    last_executed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    entry_node_id text
);


--
-- Name: crm_broadcast_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_broadcast_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    broadcast_id uuid NOT NULL,
    contact_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    whatsapp_message_id text,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    replied_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT crm_broadcast_recipients_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'replied'::text, 'failed'::text])))
);


--
-- Name: crm_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_broadcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    template_name text NOT NULL,
    template_language text DEFAULT 'en_US'::text NOT NULL,
    template_variables jsonb,
    audience_filter jsonb,
    scheduled_at timestamp with time zone,
    status text DEFAULT 'draft'::text NOT NULL,
    total_recipients integer DEFAULT 0,
    sent_count integer DEFAULT 0,
    delivered_count integer DEFAULT 0,
    read_count integer DEFAULT 0,
    replied_count integer DEFAULT 0,
    failed_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT crm_broadcasts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: crm_canned_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_canned_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    shortcut text NOT NULL,
    message text NOT NULL,
    category text DEFAULT 'General'::text,
    variables jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: crm_contact_custom_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_contact_custom_values (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    custom_field_id uuid NOT NULL,
    value text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: crm_contact_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_contact_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    user_id uuid NOT NULL,
    note_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: crm_contact_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_contact_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: crm_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    phone text NOT NULL,
    name text,
    email text,
    company text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    source text DEFAULT 'manual'::text,
    source_metadata jsonb DEFAULT '{}'::jsonb,
    assigned_to uuid,
    call_status text DEFAULT 'pending'::text,
    next_followup_at timestamp with time zone,
    last_call_notes text,
    CONSTRAINT crm_contacts_call_status_check CHECK ((call_status = ANY (ARRAY['pending'::text, 'interested'::text, 'not_interested'::text, 'callback'::text, 'no_answer'::text])))
);


--
-- Name: crm_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_agent_id uuid,
    last_message_text text,
    last_message_at timestamp with time zone,
    unread_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    flow_owner character varying(10) DEFAULT 'bot'::character varying NOT NULL,
    flow_cooldown_until timestamp with time zone,
    flow_cooldown_source text,
    flow_cooldown_updated_at timestamp with time zone
);


--
-- Name: crm_custom_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_custom_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    field_name text NOT NULL,
    field_type text DEFAULT 'text'::text NOT NULL,
    field_options jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: crm_deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_deals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    contact_id uuid,
    conversation_id uuid,
    assigned_to uuid,
    title text NOT NULL,
    value numeric(12,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text,
    notes text,
    expected_close_date date,
    status text DEFAULT 'open'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT crm_deals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])))
);


--
-- Name: crm_flow_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_flow_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    flow_id uuid NOT NULL,
    node_key text NOT NULL,
    media_type text NOT NULL,
    storage_path text NOT NULL,
    original_name text,
    mime_type text,
    size_bytes integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_flow_media_media_type_check CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text, 'document'::text, 'audio'::text])))
);


--
-- Name: crm_flow_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_flow_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    flow_id uuid NOT NULL,
    node_key text NOT NULL,
    node_type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    position_x integer DEFAULT 0 NOT NULL,
    position_y integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_flow_nodes_node_type_check CHECK ((node_type = ANY (ARRAY['start'::text, 'wait'::text, 'send_message'::text, 'send_template'::text, 'send_media'::text, 'send_buttons'::text, 'send_list'::text, 'send_carousel'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'add_tag'::text, 'remove_tag'::text, 'handoff'::text, 'end'::text, 'ai_agent'::text, 'ai_model'::text, 'ai_memory'::text, 'ai_tool'::text, 'request_location'::text, 'request_address'::text, 'whatsapp_form'::text, 'sales_crm'::text, 'notify'::text, 'create_order'::text, 'format_order_summary'::text, 'clear_cart'::text, 'confirm_order'::text, 'reject_order'::text, 'uber_direct_delivery'::text, 'track_order_status'::text, 'if_elseif_else'::text, 'calculate_distance'::text])))
);


--
-- Name: crm_flow_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_flow_run_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    flow_run_id uuid NOT NULL,
    event_type text NOT NULL,
    node_key text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_flow_run_events_event_type_check CHECK ((event_type = ANY (ARRAY['started'::text, 'node_entered'::text, 'message_sent'::text, 'reply_received'::text, 'fallback_fired'::text, 'handoff'::text, 'timeout'::text, 'error'::text, 'completed'::text, 'ai_agent_suspended'::text, 'flow_resumed'::text, 'ai_agent_no_reply'::text, 'ai_agent_skipped'::text, 'tool_executed'::text])))
);


--
-- Name: crm_flow_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_flow_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    flow_id uuid NOT NULL,
    user_id uuid NOT NULL,
    contact_id uuid,
    conversation_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    current_node_key text,
    last_prompt_message_id uuid,
    vars jsonb DEFAULT '{}'::jsonb NOT NULL,
    reprompt_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_advanced_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    last_inbound_message_id text,
    CONSTRAINT crm_flow_runs_status_check CHECK ((status = ANY (ARRAY['active'::text, 'waiting'::text, 'completed'::text, 'failed'::text, 'aborted'::text, 'handed_off'::text])))
);


--
-- Name: crm_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_flows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    trigger_type text,
    trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    entry_node_id text,
    fallback_policy jsonb DEFAULT '{"on_exhaust": "handoff", "max_reprompts": 2, "on_timeout_hours": 24, "on_unknown_reply": "reprompt"}'::jsonb NOT NULL,
    execution_count integer DEFAULT 0 NOT NULL,
    last_executed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_flows_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text]))),
    CONSTRAINT crm_flows_trigger_type_check CHECK (((trigger_type IS NULL) OR (trigger_type = ''::text) OR (trigger_type = ANY (ARRAY['keyword'::text, 'first_inbound_message'::text, 'any_inbound_message'::text, 'manual'::text, 'inbound_whatsapp_message'::text, 'campaign_status_changed'::text, 'voice_call_completed'::text, 'human_handoff_triggered'::text, 'widget_submitted'::text, 'webhook_lead_payload_received'::text, 'manual_entry'::text]))))
);


--
-- Name: COLUMN crm_flows.trigger_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.crm_flows.trigger_type IS 'How the flow is activated: keyword, first_inbound_message, any_inbound_message, manual, or unified event types: inbound_whatsapp_message, campaign_status_changed, voice_call_completed, human_handoff_triggered, widget_submitted, webhook_lead_payload_received, manual_entry.';


--
-- Name: crm_message_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_message_reactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id uuid,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT crm_message_reactions_actor_type_check CHECK ((actor_type = ANY (ARRAY['customer'::text, 'agent'::text])))
);


--
-- Name: crm_message_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_message_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    category text DEFAULT 'Marketing'::text NOT NULL,
    language text DEFAULT 'en_US'::text,
    header_type text,
    header_content text,
    header_handle text,
    header_media_url text,
    body_text text NOT NULL,
    footer_text text,
    buttons jsonb,
    sample_values jsonb,
    status text DEFAULT 'DRAFT'::text,
    meta_template_id text,
    rejection_reason text,
    quality_score text,
    submission_error text,
    last_submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT crm_message_templates_category_check CHECK ((category = ANY (ARRAY['Marketing'::text, 'Utility'::text, 'Authentication'::text]))),
    CONSTRAINT crm_message_templates_header_type_check CHECK ((header_type = ANY (ARRAY['text'::text, 'image'::text, 'video'::text, 'document'::text]))),
    CONSTRAINT crm_message_templates_quality_score_check CHECK ((quality_score = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text]))),
    CONSTRAINT crm_message_templates_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'PAUSED'::text, 'DISABLED'::text, 'IN_APPEAL'::text, 'PENDING_DELETION'::text])))
);


--
-- Name: crm_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_type text NOT NULL,
    sender_id uuid,
    content_type text DEFAULT 'text'::text NOT NULL,
    content_text text,
    media_url text,
    template_name text,
    message_id text,
    status text DEFAULT 'sent'::text NOT NULL,
    reply_to_message_id uuid,
    interactive_reply_id text,
    created_at timestamp with time zone DEFAULT now(),
    error_message text,
    CONSTRAINT crm_messages_content_type_check CHECK ((content_type = ANY (ARRAY['text'::text, 'image'::text, 'document'::text, 'audio'::text, 'video'::text, 'location'::text, 'template'::text, 'interactive'::text]))),
    CONSTRAINT crm_messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['customer'::text, 'agent'::text, 'bot'::text]))),
    CONSTRAINT crm_messages_status_check CHECK ((status = ANY (ARRAY['sending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])))
);


--
-- Name: crm_pipeline_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_pipeline_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_id uuid NOT NULL,
    name text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    color text DEFAULT '#3b82f6'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: crm_pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_pipelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    routing_key text
);


--
-- Name: crm_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#3b82f6'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: delivery_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_staff (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    driver_id text NOT NULL,
    full_name text NOT NULL,
    phone text NOT NULL,
    password_hash text NOT NULL,
    is_temp_password boolean DEFAULT true NOT NULL,
    vehicle_type text DEFAULT 'scooter'::text NOT NULL,
    vehicle_number text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT delivery_staff_status_check CHECK ((status = ANY (ARRAY['available'::text, 'on_delivery'::text, 'offline'::text]))),
    CONSTRAINT delivery_staff_vehicle_type_check CHECK ((vehicle_type = ANY (ARRAY['scooter'::text, 'bicycle'::text, 'car'::text])))
);


--
-- Name: food_store_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.food_store_settings (
    user_id uuid NOT NULL,
    is_accepting_orders boolean DEFAULT true NOT NULL,
    closed_message text DEFAULT 'We are currently closed and not accepting new orders. Please check back during operational hours!'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ringtone_duration_seconds integer DEFAULT 15,
    auto_schedule_enabled boolean DEFAULT false,
    opening_time text DEFAULT '09:00'::text,
    closing_time text DEFAULT '22:00'::text,
    operating_days jsonb DEFAULT '["mon", "tue", "wed", "thu", "fri", "sat", "sun"]'::jsonb
);


--
-- Name: instagram_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ig_account_id character varying(255) NOT NULL,
    page_id character varying(255),
    account_name character varying(255),
    username character varying(255),
    profile_picture_url text,
    access_token text NOT NULL,
    token_expires_at timestamp with time zone,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: instagram_action_dispatch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_action_dispatch (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ig_account_id character varying(255) NOT NULL,
    action_type character varying(50) NOT NULL,
    dedup_key character varying(500) NOT NULL,
    status character varying(20) DEFAULT 'QUEUED'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    error_message text,
    payload jsonb NOT NULL,
    related_dm_log_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sent_at timestamp with time zone
);


--
-- Name: instagram_ai_audit_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_ai_audit_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ig_account_id character varying(255) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    frequency character varying(20) DEFAULT 'daily'::character varying NOT NULL,
    recent_message_limit integer DEFAULT 5 NOT NULL,
    default_mode character varying(20) DEFAULT 'recent'::character varying NOT NULL,
    targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    audited_until timestamp with time zone,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    locked_run_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT instagram_ai_audit_configs_default_mode_check CHECK (((default_mode)::text = ANY ((ARRAY['recent'::character varying, 'date_range'::character varying])::text[]))),
    CONSTRAINT instagram_ai_audit_configs_frequency_check CHECK (((frequency)::text = ANY ((ARRAY['daily'::character varying, 'every_2_days'::character varying, 'weekly'::character varying, 'monthly'::character varying])::text[]))),
    CONSTRAINT instagram_ai_audit_configs_recent_message_limit_check CHECK (((recent_message_limit >= 5) AND (recent_message_limit <= 50)))
);


--
-- Name: instagram_ai_audit_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_ai_audit_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ig_account_id character varying(255) NOT NULL,
    config_id uuid,
    trigger_type character varying(20) NOT NULL,
    mode character varying(20) NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    message_limit integer,
    status character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    conversations_checked integer DEFAULT 0 NOT NULL,
    conversations_failed integer DEFAULT 0 NOT NULL,
    opportunities_found integer DEFAULT 0 NOT NULL,
    opportunities_updated integer DEFAULT 0 NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    usage jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    heartbeat_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT instagram_ai_audit_runs_mode_check CHECK (((mode)::text = ANY ((ARRAY['recent'::character varying, 'date_range'::character varying])::text[]))),
    CONSTRAINT instagram_ai_audit_runs_status_check CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT instagram_ai_audit_runs_trigger_type_check CHECK (((trigger_type)::text = ANY ((ARRAY['scheduled'::character varying, 'manual'::character varying])::text[])))
);


--
-- Name: instagram_ai_opportunities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_ai_opportunities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ig_account_id character varying(255) NOT NULL,
    conversation_key character varying(255) NOT NULL,
    sender_id character varying(255) NOT NULL,
    sender_username character varying(255),
    sender_profile_pic text,
    target_id character varying(64) NOT NULL,
    target_type character varying(20) NOT NULL,
    target_name character varying(100),
    confidence numeric(4,3) NOT NULL,
    ai_summary text NOT NULL,
    ai_reasoning text,
    brand character varying(255),
    budget character varying(255),
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    first_message_at timestamp with time zone,
    message_at timestamp with time zone,
    last_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_run_id uuid,
    status character varying(20) DEFAULT 'new'::character varying NOT NULL,
    user_summary text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT instagram_ai_opportunities_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT instagram_ai_opportunities_status_check CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'contacted'::character varying, 'won'::character varying, 'dismissed'::character varying])::text[]))),
    CONSTRAINT instagram_ai_opportunities_target_type_check CHECK (((target_type)::text = ANY ((ARRAY['leads'::character varying, 'brand_promotions'::character varying, 'collaborations'::character varying, 'custom'::character varying])::text[])))
);


--
-- Name: instagram_automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_automation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ig_account_id character varying(255) NOT NULL,
    rule_name character varying(255) NOT NULL,
    post_id character varying(255) DEFAULT 'ALL'::character varying,
    post_caption_preview text,
    post_thumbnail_url text,
    keywords jsonb DEFAULT '[]'::jsonb NOT NULL,
    dm_template text NOT NULL,
    is_active boolean DEFAULT true,
    trigger_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    trigger_type character varying(50) DEFAULT 'keyword'::character varying,
    trigger_value text,
    public_replies jsonb DEFAULT '[]'::jsonb,
    send_public_reply boolean DEFAULT true,
    target_type character varying(50) DEFAULT 'all'::character varying,
    match_mode character varying(50) DEFAULT 'exact'::character varying,
    buttons jsonb DEFAULT '[]'::jsonb,
    follow_gate_enabled boolean DEFAULT false,
    follow_gate_message text,
    follow_gate_button_label character varying(100) DEFAULT 'I Followed! ???'::character varying,
    follow_gate_not_following_message text,
    auto_like_comment boolean DEFAULT false,
    follow_up_enabled boolean DEFAULT false,
    follow_up_delay_minutes integer DEFAULT 15,
    follow_up_message text,
    link_clicks_count integer DEFAULT 0,
    total_triggers_count integer DEFAULT 0
);


--
-- Name: instagram_deleted_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_deleted_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    message_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: instagram_dm_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_dm_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    rule_id uuid,
    ig_account_id character varying(255) NOT NULL,
    post_id character varying(255),
    comment_id character varying(255),
    commenter_id character varying(255) NOT NULL,
    commenter_username character varying(255),
    comment_text text,
    matched_keyword character varying(255),
    dm_text text,
    status character varying(50) NOT NULL,
    error_message text,
    sent_at timestamp with time zone DEFAULT now(),
    is_read boolean DEFAULT false,
    read_at timestamp with time zone,
    reactions jsonb DEFAULT '[]'::jsonb,
    media_url text,
    media_type character varying(50),
    reply_to_mid character varying(255),
    message_id character varying(255),
    is_deleted boolean DEFAULT false,
    direction character varying(20) DEFAULT 'outbound'::character varying,
    conversation_key character varying(255),
    raw_payload jsonb,
    card_template jsonb,
    quick_replies jsonb DEFAULT '[]'::jsonb,
    follow_gate_status character varying(50),
    followed_at timestamp with time zone,
    follow_up_status character varying(50),
    follow_up_sent_at timestamp with time zone,
    public_reply_text text,
    public_reply_sent_at timestamp with time zone,
    clicked_at timestamp with time zone
);


--
-- Name: instagram_rate_limit_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_rate_limit_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ig_account_id character varying(255) NOT NULL,
    action_type character varying(50) NOT NULL,
    limit_per_hour integer NOT NULL,
    updated_by character varying(255),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: instagram_rate_limit_config_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_rate_limit_config_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ig_account_id character varying(255) NOT NULL,
    action_type character varying(50) NOT NULL,
    old_limit_per_hour integer,
    new_limit_per_hour integer NOT NULL,
    changed_by character varying(255),
    changed_at timestamp with time zone DEFAULT now()
);


--
-- Name: instagram_tracked_link_clicks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_tracked_link_clicks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    tracked_link_id uuid,
    ip_address character varying(100),
    user_agent text,
    referer text,
    clicked_at timestamp with time zone DEFAULT now()
);


--
-- Name: instagram_tracked_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_tracked_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    rule_id uuid,
    slug character varying(64) NOT NULL,
    title character varying(255),
    destination_url text NOT NULL,
    clicks_count integer DEFAULT 0,
    unique_clicks_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: instagram_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    object_type text NOT NULL,
    event_type text NOT NULL,
    raw_payload_json jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now(),
    processed_at timestamp with time zone,
    processing_status text DEFAULT 'pending'::text,
    error_message text,
    CONSTRAINT instagram_webhook_events_processing_status_check CHECK ((processing_status = ANY (ARRAY['pending'::text, 'processed'::text, 'failed'::text, 'unmatched_account'::text])))
);


--
-- Name: journey_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journey_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    contact_id uuid,
    campaign_id uuid,
    status text DEFAULT 'running'::text NOT NULL,
    wait_type text,
    wait_until timestamp with time zone,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    step_log jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    current_node_key text,
    CONSTRAINT journey_instances_status_check CHECK ((status = ANY (ARRAY['running'::text, 'waiting'::text, 'completed'::text, 'exited'::text, 'failed'::text]))),
    CONSTRAINT journey_instances_wait_type_check CHECK ((wait_type = ANY (ARRAY['time'::text, 'call_concluded'::text, 'whatsapp_read'::text])))
);


--
-- Name: knowledge_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    content text NOT NULL,
    embedding public.vector(384),
    created_at timestamp with time zone DEFAULT now(),
    embedding_v2 public.vector(1024),
    embedding_model text DEFAULT 'minilm-l6-v2'::text
);


--
-- Name: knowledge_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    title text NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'processing'::text,
    source_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT knowledge_documents_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT knowledge_documents_type_check CHECK ((type = ANY (ARRAY['pdf'::text, 'text'::text, 'url'::text, 'faq'::text])))
);


--
-- Name: languages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.languages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    language_name character varying(100) NOT NULL,
    language_code character varying(20) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: legacy_call_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legacy_call_logs (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    phone_number text,
    duration_seconds integer,
    transcript text,
    summary text,
    sentiment text,
    estimated_cost_usd numeric(10,5),
    call_date date,
    call_hour integer,
    call_day_of_week text,
    was_booked boolean DEFAULT false,
    interrupt_count integer DEFAULT 0,
    audio_codec text
);


--
-- Name: legacy_call_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.legacy_call_logs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.legacy_call_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: llm_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name character varying(100) NOT NULL,
    model_identifier character varying(200) NOT NULL,
    provider_name character varying(100) NOT NULL,
    api_key_encrypted text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    pricing_per_1k_tokens numeric(10,6),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: menu_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    menu_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    price numeric(10,2) DEFAULT 0.00 NOT NULL,
    is_available boolean DEFAULT true NOT NULL,
    category text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sku text
);


--
-- Name: menus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menus (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    restaurant_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: minutes_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.minutes_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    minutes numeric(10,4) NOT NULL,
    balance_after numeric(10,4) NOT NULL,
    description text,
    reference_type text,
    reference_id text,
    performed_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT minutes_transactions_type_check CHECK ((type = ANY (ARRAY['credit'::text, 'debit'::text, 'refund'::text])))
);


--
-- Name: omnidim_call_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.omnidim_call_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid,
    contact_id uuid,
    caller_phone text,
    direction text DEFAULT 'outbound'::text,
    call_status text,
    intent_classification text,
    bridge_outcome text,
    sentiment text,
    summary text,
    transcript text,
    recording_url text,
    call_duration_sec integer,
    action_taken text,
    omnidim_call_id text,
    raw_payload jsonb,
    called_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT omnidim_call_logs_direction_check CHECK ((direction = ANY (ARRAY['outbound'::text, 'inbound'::text])))
);


--
-- Name: omnidim_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.omnidim_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text,
    voice_profile_id uuid,
    outbound_agent_id text,
    inbound_agent_id text,
    concurrent_calls integer DEFAULT 1,
    phone_number text,
    schedule text DEFAULT 'immediate'::text,
    total_contacts integer DEFAULT 0,
    contacts_called integer DEFAULT 0,
    contacts_interested integer DEFAULT 0,
    contacts_not_interested integer DEFAULT 0,
    contacts_not_lifted integer DEFAULT 0,
    csv_file_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    agent_name text,
    company_domain text,
    lead_source text DEFAULT 'csv'::text NOT NULL,
    webhook_integration_id uuid,
    routing_key text,
    agent_variables jsonb DEFAULT '{}'::jsonb,
    journey_automation_id uuid,
    scheduled_at timestamp with time zone,
    CONSTRAINT omnidim_campaigns_lead_source_check CHECK ((lead_source = ANY (ARRAY['csv'::text, 'webhook'::text]))),
    CONSTRAINT omnidim_campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'completed'::text, 'failed'::text, 'scheduled'::text])))
);


--
-- Name: omnidim_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.omnidim_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    phone_number text NOT NULL,
    name text DEFAULT ''::text,
    call_status text DEFAULT 'pending'::text,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    next_call_at timestamp with time zone,
    last_call_at timestamp with time zone,
    custom_variables jsonb DEFAULT '{}'::jsonb,
    omnidim_call_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    priority_flag boolean DEFAULT false,
    priority_reason text,
    source_webhook_id uuid,
    source_metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT omnidim_contacts_call_status_check CHECK ((call_status = ANY (ARRAY['pending'::text, 'calling'::text, 'completed'::text, 'interested'::text, 'not_interested'::text, 'not_lifted'::text, 'callback_later'::text, 'failed'::text, 'bridged_success'::text, 'bridged_failed'::text, 'voicemail'::text, 'no_answer'::text, 'busy'::text])))
);


--
-- Name: omnidim_custom_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.omnidim_custom_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type character varying(20) NOT NULL,
    name character varying(255) NOT NULL,
    url_slug character varying(255) NOT NULL,
    secret_token character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    description text,
    method character varying(20) DEFAULT 'POST'::character varying,
    headers jsonb DEFAULT '[]'::jsonb,
    query_params jsonb DEFAULT '[]'::jsonb,
    config jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT omnidim_custom_integrations_type_check CHECK (((type)::text = ANY (ARRAY[('webhook'::character varying)::text, ('api'::character varying)::text])))
);


--
-- Name: order_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid NOT NULL,
    event_type text NOT NULL,
    source text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT order_events_event_type_check CHECK ((event_type = ANY (ARRAY['order_placed'::text, 'restaurant_confirmed'::text, 'restaurant_rejected'::text, 'courier_requested'::text, 'courier_assigned'::text, 'courier_no_match'::text, 'picked_up'::text, 'delivered'::text, 'canceled'::text]))),
    CONSTRAINT order_events_source_check CHECK ((source = ANY (ARRAY['customer'::text, 'restaurant'::text, 'uber_webhook'::text, 'system_timeout'::text, 'inhouse_driver'::text, 'merchant'::text])))
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_code text NOT NULL,
    user_id uuid NOT NULL,
    customer_phone text NOT NULL,
    restaurant_id uuid,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    subtotal numeric(10,2) DEFAULT 0.00 NOT NULL,
    delivery_fee numeric(10,2) DEFAULT 0.00 NOT NULL,
    total numeric(10,2) DEFAULT 0.00 NOT NULL,
    status text DEFAULT 'placed'::text NOT NULL,
    delivery_address text NOT NULL,
    delivery_latitude double precision,
    delivery_longitude double precision,
    uber_direct_delivery_id text,
    uber_tracking_url text,
    restaurant_confirmed_at timestamp with time zone,
    prep_ready_at_estimate timestamp with time zone,
    courier_assigned_at timestamp with time zone,
    picked_up_at timestamp with time zone,
    delivered_at timestamp with time zone,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    dispatch_attempts integer DEFAULT 0 NOT NULL,
    custom_order_id text,
    inhouse_driver_id uuid,
    inhouse_driver_name text,
    inhouse_driver_phone text,
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['placed'::text, 'restaurant_confirmed'::text, 'restaurant_rejected'::text, 'preparing'::text, 'courier_requested'::text, 'courier_assigned'::text, 'courier_no_match'::text, 'picked_up'::text, 'delivered'::text, 'canceled'::text])))
);


--
-- Name: organization_configurations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_configurations (
    id integer NOT NULL,
    organization_id integer NOT NULL,
    key character varying NOT NULL,
    value json NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    last_validated_at timestamp with time zone
);


--
-- Name: organization_configurations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.organization_configurations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: organization_configurations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.organization_configurations_id_seq OWNED BY public.organization_configurations.id;


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id integer NOT NULL,
    provider_id character varying NOT NULL,
    created_at timestamp with time zone
);


--
-- Name: organizations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.organizations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: organizations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.organizations_id_seq OWNED BY public.organizations.id;


--
-- Name: platform_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_config (
    id integer DEFAULT 1 NOT NULL,
    global_allowed_models text[] DEFAULT '{}'::text[] NOT NULL,
    global_allowed_languages text[] DEFAULT '{}'::text[] NOT NULL,
    vobiz_master_balance numeric(12,2),
    low_balance_threshold numeric(12,2),
    alert_email character varying(255),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_uber_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_uber_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id text NOT NULL,
    client_secret_encrypted text NOT NULL,
    root_organization_id text NOT NULL,
    environment text DEFAULT 'sandbox'::text NOT NULL,
    webhook_signing_secret_encrypted text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT platform_uber_settings_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text])))
);


--
-- Name: platform_voice_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_voice_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    api_key_encrypted text NOT NULL,
    base_url text,
    is_active boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: platform_voice_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_voice_profiles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    provider text NOT NULL,
    voice_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: platform_voice_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_voice_settings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    omnidim_api_key_encrypted text,
    vobiz_api_key_encrypted text,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid
);


--
-- Name: platform_whatsapp_ai_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_whatsapp_ai_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    custom_models jsonb DEFAULT '[]'::jsonb,
    model_pricing jsonb DEFAULT '{}'::jsonb,
    usd_to_inr numeric(10,2) DEFAULT 85.00,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid
);


--
-- Name: platform_whatsapp_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_whatsapp_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meta_app_id text,
    meta_app_secret_encrypted text,
    meta_api_version text DEFAULT 'v20.0'::text,
    webhook_base_url text,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid
);


--
-- Name: pricing_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    monthly_price integer,
    annual_price integer,
    color text DEFAULT 'border-slate-200'::text,
    accent text DEFAULT 'text-slate-700'::text,
    btn_class text DEFAULT 'bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700'::text,
    is_popular boolean DEFAULT false,
    features jsonb DEFAULT '[]'::jsonb,
    annual_discount_badge text DEFAULT '-20%'::text,
    icon_name text DEFAULT 'Zap'::text,
    display_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pricing_plans_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_plans_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid,
    plans_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: public_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    api_key text NOT NULL,
    name text DEFAULT 'Website Widget'::text,
    allowed_domains text[],
    is_active boolean DEFAULT true,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: reconciliation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliation_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    platform_balance numeric(12,2),
    vobiz_balance numeric(12,2),
    drift_amount numeric(12,2),
    status character varying(20),
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: restaurants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    whatsapp_number text,
    address text NOT NULL,
    latitude double precision,
    longitude double precision,
    is_open boolean DEFAULT true NOT NULL,
    avg_prep_time_minutes integer DEFAULT 20 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    closed_message text DEFAULT 'We are currently closed and not accepting new orders. Please check back during operational hours!'::text
);


--
-- Name: sales_crm_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_crm_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    customer_name text,
    customer_phone text NOT NULL,
    customer_email text,
    source text,
    contact_status text DEFAULT 'Not Contacted'::text,
    qualification_status text DEFAULT 'Pending'::text,
    site_visit_status text DEFAULT 'Not Scheduled'::text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
    reminder_date timestamp with time zone,
    feedback text,
    ai_call_status text,
    ai_call_log_id uuid,
    campaign_id uuid,
    campaign_name text,
    omnidim_contact_id uuid,
    project text,
    CONSTRAINT sales_crm_leads_contact_status_check CHECK ((contact_status = ANY (ARRAY['Not Contacted'::text, 'Contacted'::text]))),
    CONSTRAINT sales_crm_leads_qualification_status_check CHECK ((qualification_status = ANY (ARRAY['Pending'::text, 'Qualified'::text, 'Not Qualified'::text]))),
    CONSTRAINT sales_crm_leads_site_visit_status_check CHECK ((site_visit_status = ANY (ARRAY['Not Scheduled'::text, 'Scheduled'::text])))
);


--
-- Name: scheduled_followups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_followups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contact_phone character varying(50) NOT NULL,
    contact_id uuid,
    conversation_id uuid,
    messages jsonb NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    scheduled_at_ist character varying(100),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    bullmq_job_id character varying(100),
    cancel_on_reply boolean DEFAULT false,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    jwt_token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    is_revoked boolean DEFAULT false
);


--
-- Name: tag_to_agent_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tag_to_agent_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telecaller_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telecaller_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    telecaller_id uuid NOT NULL,
    jwt_token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    is_revoked boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: telecaller_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telecaller_shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    start_time text DEFAULT '10:00'::text NOT NULL,
    end_time text DEFAULT '18:30'::text NOT NULL,
    days_of_week integer[] DEFAULT '{1,2,3,4,5,6}'::integer[],
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid
);


--
-- Name: telecallers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telecallers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    phone_number text NOT NULL,
    password_hash text NOT NULL,
    must_reset_password boolean DEFAULT true,
    is_available boolean DEFAULT false,
    tier text DEFAULT 'T1'::text,
    calls_handled_today integer DEFAULT 0,
    last_assigned_at timestamp with time zone,
    active_call_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    CONSTRAINT telecallers_tier_check CHECK ((tier = ANY (ARRAY['T1'::text, 'T2'::text])))
);


--
-- Name: templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    category text DEFAULT 'marketing'::text,
    language text DEFAULT 'en'::text,
    body text NOT NULL,
    header text,
    footer text,
    is_approved boolean DEFAULT false,
    created_by_admin boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    tenant_id uuid,
    meta_template_id text,
    status text DEFAULT 'APPROVED'::text,
    components jsonb,
    CONSTRAINT templates_category_check CHECK ((category = ANY (ARRAY['marketing'::text, 'utility'::text, 'authentication'::text])))
);


--
-- Name: tenant_ai_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_ai_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    active_provider text,
    active_model text,
    human_takeover_keywords jsonb DEFAULT '["human", "support", "agent", "help"]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    system_prompt text,
    active_voice text,
    active_language text,
    brand_name text,
    active_stt_model text,
    active_tts_model text,
    allowed_stt_models text[] DEFAULT '{}'::text[],
    allowed_tts_models text[] DEFAULT '{}'::text[],
    tts_emotion character varying(100),
    tool_discovery_limit integer DEFAULT 5,
    max_history_messages integer DEFAULT 10,
    history_strategy text DEFAULT 'last_n'::text,
    rag_enabled boolean DEFAULT true,
    rag_top_k integer DEFAULT 5,
    compiled_agent_config jsonb,
    active_flow_id uuid,
    config_compiled_at timestamp with time zone,
    knowledge_document_ids uuid[] DEFAULT '{}'::uuid[],
    summary_interval integer DEFAULT 10,
    response_delay_enabled boolean DEFAULT false,
    response_delay_min_seconds numeric DEFAULT 3,
    response_delay_max_seconds numeric DEFAULT 8
);


--
-- Name: tenant_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_config (
    tenant_id uuid NOT NULL,
    allowed_languages text[] DEFAULT '{}'::text[] NOT NULL,
    active_model character varying(100),
    active_language character varying(100),
    active_voice character varying(100),
    system_prompt text,
    brand_name character varying(100),
    webhook_url character varying(2048),
    rate_per_minute numeric(8,2) DEFAULT 0.01 NOT NULL,
    allowed_model_ids uuid[] DEFAULT '{}'::uuid[],
    allowed_language_ids uuid[] DEFAULT '{}'::uuid[],
    allowed_voice_ids uuid[] DEFAULT '{}'::uuid[],
    active_model_id uuid,
    active_language_id uuid,
    active_voice_id uuid,
    active_stt_model text,
    active_tts_model text,
    tts_emotion character varying(100),
    CONSTRAINT ck_tenant_config_brand_name_length CHECK (((brand_name IS NULL) OR (length((brand_name)::text) <= 100))),
    CONSTRAINT ck_tenant_config_rate_per_minute_min CHECK ((rate_per_minute >= 0.01)),
    CONSTRAINT ck_tenant_config_system_prompt_length CHECK (((system_prompt IS NULL) OR (length(system_prompt) <= 4000)))
);


--
-- Name: tenant_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    email character varying(255) NOT NULL,
    role character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_tenant_users_role CHECK (((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('member'::character varying)::text])))
);


--
-- Name: tenant_whatsapp_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_whatsapp_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    phone_number_id text,
    waba_id text,
    access_token text,
    webhook_verify_token text DEFAULT (gen_random_uuid())::text,
    billing_confirmed boolean DEFAULT false,
    business_verified boolean DEFAULT false,
    meta_app_id_override text,
    plugins_enabled jsonb DEFAULT '[]'::jsonb,
    api_key_hash text,
    max_messages_per_day integer DEFAULT 1000,
    chatbot_config jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    two_step_pin text,
    is_coexistence boolean DEFAULT false,
    platform_type text,
    contacts_sync_request_id text,
    history_sync_request_id text,
    contacts_sync_status text DEFAULT 'pending'::text,
    history_sync_status text DEFAULT 'pending'::text,
    flow_auto_pause_enabled boolean DEFAULT true,
    flow_cooldown_duration integer DEFAULT 30,
    flow_cooldown_unit text DEFAULT 'minutes'::text,
    read_receipts_enabled boolean DEFAULT true NOT NULL,
    read_receipt_mode text DEFAULT 'automatic'::text NOT NULL,
    CONSTRAINT tenant_whatsapp_config_contacts_sync_status_check CHECK ((contacts_sync_status = ANY (ARRAY['pending'::text, 'completed'::text, 'declined'::text, 'failed'::text]))),
    CONSTRAINT tenant_whatsapp_config_history_sync_status_check CHECK ((history_sync_status = ANY (ARRAY['pending'::text, 'completed'::text, 'declined'::text, 'failed'::text])))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(50) NOT NULL,
    plan character varying(50),
    status character varying(20) DEFAULT 'pending_kyc'::character varying NOT NULL,
    wallet_balance numeric(12,2) DEFAULT 0.00 NOT NULL,
    vobiz_auth_id character varying(255),
    vobiz_auth_token text,
    kyc_verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_tenants_slug_format CHECK (((slug)::text ~ '^[a-z0-9\-]+$'::text)),
    CONSTRAINT ck_tenants_status CHECK (((status)::text = ANY (ARRAY[('pending_kyc'::character varying)::text, ('active'::character varying)::text, ('suspended'::character varying)::text])))
);


--
-- Name: tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    caller_phone text DEFAULT 'UNKNOWN'::text NOT NULL,
    campaign_id uuid,
    contact_id uuid,
    payload jsonb DEFAULT '{}'::jsonb,
    reason text DEFAULT 'no_agent_available'::text,
    status text DEFAULT 'OPEN'::text,
    assigned_to uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    CONSTRAINT tickets_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'IN_PROGRESS'::text, 'RESOLVED'::text, 'CLOSED'::text])))
);


--
-- Name: tool_configuration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_configuration (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tool_id uuid NOT NULL,
    config_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tool_execution_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_execution_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    contact_id text NOT NULL,
    conversation_id uuid,
    tool_name text NOT NULL,
    is_custom boolean DEFAULT false NOT NULL,
    args jsonb,
    result jsonb,
    success boolean DEFAULT true NOT NULL,
    error_message text,
    duration_ms integer,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: triggered_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.triggered_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    api_key_id uuid,
    customer_name text,
    customer_phone text NOT NULL,
    customer_email text,
    custom_fields jsonb DEFAULT '{}'::jsonb,
    agent_name text,
    company_domain text,
    call_status text DEFAULT 'pending'::text,
    omnidim_call_id text,
    call_duration_sec integer,
    minutes_deducted numeric(10,4) DEFAULT 0,
    transcript text,
    summary text,
    recording_url text,
    sentiment text,
    raw_webhook_payload jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT triggered_calls_call_status_check CHECK ((call_status = ANY (ARRAY['pending'::text, 'calling'::text, 'completed'::text, 'failed'::text, 'no_minutes'::text])))
);


--
-- Name: uber_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uber_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid,
    uber_delivery_id text,
    uber_quote_id text,
    status text DEFAULT 'draft'::text NOT NULL,
    delivery_fee numeric(10,2) DEFAULT 0.00 NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    tracking_url text,
    courier_name text,
    courier_phone text,
    courier_latitude double precision,
    courier_longitude double precision,
    courier_updated_at timestamp with time zone,
    pickup_ready_dt timestamp with time zone,
    pickup_deadline_dt timestamp with time zone,
    dropoff_ready_dt timestamp with time zone,
    dropoff_deadline_dt timestamp with time zone,
    public_tracking_token text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: uber_delivery_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uber_delivery_webhook_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    uber_delivery_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now(),
    processing_status text DEFAULT 'received'::text NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT uber_delivery_webhook_events_processing_status_check CHECK ((processing_status = ANY (ARRAY['received'::text, 'processed'::text, 'failed'::text])))
);


--
-- Name: uber_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uber_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id text,
    client_secret text,
    customer_id text,
    environment text DEFAULT 'sandbox'::text NOT NULL,
    webhook_signing_key text,
    is_connected boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    uber_organization_id text,
    root_organization_id text,
    organization_creation_status text DEFAULT 'not_started'::text,
    onboarding_status text DEFAULT 'not_started'::text,
    billing_type text,
    merchant_type text,
    error_information text,
    CONSTRAINT uber_integrations_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text])))
);


--
-- Name: uber_pickup_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uber_pickup_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    restaurant_id uuid,
    name text NOT NULL,
    address text NOT NULL,
    latitude double precision,
    longitude double precision,
    uber_store_id text,
    uber_external_store_id text,
    contact_name text,
    contact_phone text,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_google_calendar_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_google_calendar_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    google_account_id text,
    google_email text,
    access_token_encrypted jsonb NOT NULL,
    refresh_token_encrypted jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    scopes text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_inbound_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_inbound_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    agent_id text NOT NULL,
    agent_name text,
    phone_number text,
    description text,
    post_call_variables jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_outbound_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_outbound_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    display_name character varying(255) NOT NULL,
    agent_id character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    description text,
    post_call_variables jsonb DEFAULT '[]'::jsonb,
    from_phone_number text
);


--
-- Name: user_push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    subscription_json jsonb NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_voice_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_voice_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    is_active boolean DEFAULT false,
    provider text DEFAULT 'omnidim'::text NOT NULL,
    voice_id text,
    voice_name text,
    outbound_agent_id text,
    inbound_agent_id text,
    from_phone_number text,
    max_concurrent_calls integer DEFAULT 5,
    low_minutes_threshold integer DEFAULT 50,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    phone_numbers_config jsonb DEFAULT '[]'::jsonb
);


--
-- Name: user_voice_phone_numbers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_voice_phone_numbers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    phone_number text NOT NULL,
    label text DEFAULT 'Dedicated Phone ID'::text,
    max_concurrency integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    password_hash text,
    auth_provider text DEFAULT 'email'::text,
    is_verified boolean DEFAULT false,
    is_admin boolean DEFAULT false,
    otp_code text,
    otp_expires_at timestamp with time zone,
    reset_token text,
    reset_token_expires_at timestamp with time zone,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    plan text DEFAULT 'free'::text,
    credits numeric(12,4) DEFAULT 0,
    omnidim_webhook_secret character varying(255),
    omnidim_api_key character varying(255),
    has_accepted_terms boolean DEFAULT false,
    terms_accepted_at timestamp with time zone,
    voice_minutes numeric(10,4) DEFAULT 0,
    unanswered_cost_seconds integer DEFAULT 0,
    is_blocked boolean DEFAULT false,
    phone_number text,
    role text DEFAULT 'client'::text,
    agency_id uuid,
    onboarded_by uuid,
    agency_domain text,
    CONSTRAINT users_auth_provider_check CHECK ((auth_provider = ANY (ARRAY['email'::text, 'google'::text])))
);


--
-- Name: vobiz_call_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vobiz_call_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    phone_number text NOT NULL,
    phone_number_hashed text NOT NULL,
    status public.call_job_status DEFAULT 'pending'::public.call_job_status NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    last_error_code text,
    last_error_message text,
    next_retry_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vobiz_call_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT vobiz_call_jobs_max_attempts_check CHECK ((max_attempts > 0))
);


--
-- Name: vobiz_call_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vobiz_call_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    call_job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    credential_set_id uuid,
    sip_call_id text,
    call_status text NOT NULL,
    sip_response_code integer,
    duration_seconds integer,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    error_code text,
    error_message text,
    phone_number_hashed text NOT NULL,
    attempt_number integer DEFAULT 1 NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT vobiz_call_logs_call_status_check CHECK ((call_status = ANY (ARRAY['pending'::text, 'queued'::text, 'ringing'::text, 'connected'::text, 'completed'::text, 'failed'::text, 'no_answer'::text, 'busy'::text, 'rejected'::text, 'cancelled'::text])))
);


--
-- Name: vobiz_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vobiz_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    name text NOT NULL,
    status public.campaign_status DEFAULT 'draft'::public.campaign_status,
    phone_count integer DEFAULT 0,
    queued_count integer DEFAULT 0,
    completed_count integer DEFAULT 0,
    failed_count integer DEFAULT 0,
    no_answer_count integer DEFAULT 0,
    busy_count integer DEFAULT 0,
    irv_config jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    profile_id uuid,
    concurrent_calls integer DEFAULT 1,
    CONSTRAINT chk_concurrent_calls CHECK (((concurrent_calls >= 1) AND (concurrent_calls <= 5)))
);


--
-- Name: COLUMN vobiz_campaigns.profile_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vobiz_campaigns.profile_id IS 'Optional override: which agent profile to use for this campaign. NULL = use tenant default.';


--
-- Name: vobiz_credential_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vobiz_credential_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credential_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    action text NOT NULL,
    success boolean DEFAULT true NOT NULL,
    details text,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT vobiz_credential_audit_action_check CHECK ((action = ANY (ARRAY['create'::text, 'verify'::text, 'verify_failed'::text, 'update'::text, 'decrypt_attempt'::text, 'delete'::text])))
);


--
-- Name: vobiz_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vobiz_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    friendly_name text NOT NULL,
    encrypted_domain text NOT NULL,
    encrypted_domain_iv text NOT NULL,
    encrypted_domain_auth_tag text NOT NULL,
    encrypted_username text NOT NULL,
    encrypted_username_iv text NOT NULL,
    encrypted_username_auth_tag text NOT NULL,
    encrypted_password text NOT NULL,
    encrypted_password_iv text NOT NULL,
    encrypted_password_auth_tag text NOT NULL,
    verified boolean DEFAULT false,
    last_verified_at timestamp with time zone,
    verification_error_message text,
    is_deleted boolean DEFAULT false,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    deleted_reason text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    encrypted_auth_id text,
    encrypted_auth_id_iv text,
    encrypted_auth_id_auth_tag text,
    encrypted_auth_token text,
    encrypted_auth_token_iv text,
    encrypted_auth_token_auth_tag text,
    encrypted_send_number text,
    encrypted_send_number_iv text,
    encrypted_send_number_auth_tag text,
    encrypted_vobiz_number text,
    encrypted_vobiz_number_iv text,
    encrypted_vobiz_number_auth_tag text,
    trunk_type character varying(20) DEFAULT 'both'::character varying,
    inbound_profile_id uuid,
    vobiz_number_hash text
);


--
-- Name: COLUMN vobiz_credentials.encrypted_auth_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vobiz_credentials.encrypted_auth_id IS 'VoBiz API authentication ID (X-Auth-ID header, encrypted with AES-256-GCM)';


--
-- Name: COLUMN vobiz_credentials.encrypted_auth_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vobiz_credentials.encrypted_auth_token IS 'VoBiz API authentication token (X-Auth-Token header, encrypted with AES-256-GCM)';


--
-- Name: COLUMN vobiz_credentials.encrypted_send_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vobiz_credentials.encrypted_send_number IS 'Caller ID number displayed to recipients (E.164 format, encrypted with AES-256-GCM)';


--
-- Name: COLUMN vobiz_credentials.encrypted_vobiz_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vobiz_credentials.encrypted_vobiz_number IS 'DID (Direct Inward Dialing) number assigned to account (E.164 format, encrypted with AES-256-GCM)';


--
-- Name: voice_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    provider text DEFAULT 'omnidim'::text NOT NULL,
    voice_id text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid
);


--
-- Name: wallet_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    type character varying(20) NOT NULL,
    amount_inr numeric(12,2) NOT NULL,
    description text,
    payment_ref character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_wallet_transactions_type CHECK (((type)::text = ANY (ARRAY[('topup'::character varying)::text, ('deduction'::character varying)::text, ('refund'::character varying)::text, ('adjustment'::character varying)::text])))
);


--
-- Name: webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'processed'::text,
    error_message text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    phone_number text,
    waba_id text,
    phone_number_id text,
    status text DEFAULT 'pending'::text,
    connected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    access_token text,
    webhook_verify_token text,
    display_name text,
    channel_type text DEFAULT 'whatsapp'::text NOT NULL,
    plugins_enabled jsonb DEFAULT '[]'::jsonb NOT NULL,
    ai_chatbot_enabled boolean DEFAULT false NOT NULL,
    knowledge_base_id uuid,
    crm_flow_id uuid,
    crm_flow_enabled boolean DEFAULT false NOT NULL,
    chatbot_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    meta_app_id_override text,
    billing_confirmed boolean DEFAULT false NOT NULL,
    business_verified boolean DEFAULT false NOT NULL,
    api_key_hash text,
    max_messages_per_day integer DEFAULT 1000 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_coexistence boolean DEFAULT false,
    platform_type text,
    contacts_sync_request_id text,
    history_sync_request_id text,
    contacts_sync_status text DEFAULT 'pending'::text,
    history_sync_status text DEFAULT 'pending'::text,
    connection_type text DEFAULT 'manual'::text,
    is_primary boolean DEFAULT false,
    read_receipts_enabled boolean,
    read_receipt_mode text,
    CONSTRAINT whatsapp_accounts_channel_type_check CHECK ((channel_type = ANY (ARRAY['whatsapp'::text, 'facebook'::text, 'instagram'::text, 'sms'::text]))),
    CONSTRAINT whatsapp_accounts_connection_type_check CHECK ((connection_type = ANY (ARRAY['manual'::text, 'embedded'::text]))),
    CONSTRAINT whatsapp_accounts_contacts_sync_status_check CHECK ((contacts_sync_status = ANY (ARRAY['pending'::text, 'completed'::text, 'declined'::text, 'failed'::text]))),
    CONSTRAINT whatsapp_accounts_history_sync_status_check CHECK ((history_sync_status = ANY (ARRAY['pending'::text, 'completed'::text, 'declined'::text, 'failed'::text]))),
    CONSTRAINT whatsapp_accounts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'connected'::text, 'disconnected'::text, 'active'::text, 'inactive'::text])))
);


--
-- Name: whatsapp_form_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_form_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    form_id uuid NOT NULL,
    user_id uuid NOT NULL,
    contact_id uuid,
    phone_number character varying(50),
    response_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    meta_flow_id character varying(255),
    status character varying(50) DEFAULT 'DRAFT'::character varying NOT NULL,
    categories jsonb DEFAULT '["OTHER"]'::jsonb,
    json_definition jsonb DEFAULT '{}'::jsonb,
    crm_field_mapping jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    from_number text NOT NULL,
    to_number text NOT NULL,
    message_type text DEFAULT 'text'::text,
    content jsonb DEFAULT '{}'::jsonb,
    direction text NOT NULL,
    status text DEFAULT 'received'::text,
    wa_message_id text,
    "timestamp" timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    campaign_id uuid,
    error_message text,
    CONSTRAINT whatsapp_messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))
);


--
-- Name: whatsapp_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    template_name text NOT NULL,
    language_code text DEFAULT 'en_US'::text,
    status text DEFAULT 'PENDING'::text,
    category text,
    components jsonb DEFAULT '[]'::jsonb,
    meta_template_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT whatsapp_templates_category_check CHECK ((category = ANY (ARRAY['MARKETING'::text, 'UTILITY'::text, 'AUTHENTICATION'::text]))),
    CONSTRAINT whatsapp_templates_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])))
);


--
-- Name: workspace_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    email text NOT NULL,
    role_id uuid,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    phone_number text
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    member_user_id uuid NOT NULL,
    role_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_telecaller boolean DEFAULT false
);


--
-- Name: chatbot_corpus id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chatbot_corpus ALTER COLUMN id SET DEFAULT nextval('public.chatbot_corpus_id_seq'::regclass);


--
-- Name: organization_configurations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_configurations ALTER COLUMN id SET DEFAULT nextval('public.organization_configurations_id_seq'::regclass);


--
-- Name: organizations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations ALTER COLUMN id SET DEFAULT nextval('public.organizations_id_seq'::regclass);


--
-- Name: organization_configurations _organization_key_uc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_configurations
    ADD CONSTRAINT _organization_key_uc UNIQUE (organization_id, key);


--
-- Name: active_calls active_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_calls
    ADD CONSTRAINT active_calls_pkey PRIMARY KEY (room_id);


--
-- Name: active_transfers active_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_transfers
    ADD CONSTRAINT active_transfers_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_logs admin_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_logs
    ADD CONSTRAINT admin_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: agent_action_assets agent_action_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_action_assets
    ADD CONSTRAINT agent_action_assets_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_assets agent_tool_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_assets
    ADD CONSTRAINT agent_tool_assets_pkey PRIMARY KEY (id);


--
-- Name: agent_tools agent_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_pkey PRIMARY KEY (id);


--
-- Name: agent_tools agent_tools_tenant_name_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_tenant_name_version_unique UNIQUE (tenant_id, name, version);


--
-- Name: ai_providers ai_providers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_providers
    ADD CONSTRAINT ai_providers_name_key UNIQUE (name);


--
-- Name: ai_providers ai_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_providers
    ADD CONSTRAINT ai_providers_pkey PRIMARY KEY (id);


--
-- Name: ai_usage_logs ai_usage_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_logs
    ADD CONSTRAINT ai_usage_logs_pkey PRIMARY KEY (id);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: blog_categories blog_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_categories
    ADD CONSTRAINT blog_categories_name_key UNIQUE (name);


--
-- Name: blog_categories blog_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_categories
    ADD CONSTRAINT blog_categories_pkey PRIMARY KEY (id);


--
-- Name: blog_categories blog_categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_categories
    ADD CONSTRAINT blog_categories_slug_key UNIQUE (slug);


--
-- Name: blog_post_categories blog_post_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_post_categories
    ADD CONSTRAINT blog_post_categories_pkey PRIMARY KEY (post_id, category_id);


--
-- Name: blog_post_tags blog_post_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_post_tags
    ADD CONSTRAINT blog_post_tags_pkey PRIMARY KEY (post_id, tag_id);


--
-- Name: blog_posts blog_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_posts
    ADD CONSTRAINT blog_posts_pkey PRIMARY KEY (id);


--
-- Name: blog_posts blog_posts_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_posts
    ADD CONSTRAINT blog_posts_slug_key UNIQUE (slug);


--
-- Name: blog_tags blog_tags_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_tags
    ADD CONSTRAINT blog_tags_name_key UNIQUE (name);


--
-- Name: blog_tags blog_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_tags
    ADD CONSTRAINT blog_tags_pkey PRIMARY KEY (id);


--
-- Name: blog_tags blog_tags_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_tags
    ADD CONSTRAINT blog_tags_slug_key UNIQUE (slug);


--
-- Name: legacy_call_logs call_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_call_logs
    ADD CONSTRAINT call_logs_pkey PRIMARY KEY (id);


--
-- Name: call_logs call_logs_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_pkey1 PRIMARY KEY (id);


--
-- Name: call_transcripts call_transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_transcripts
    ADD CONSTRAINT call_transcripts_pkey PRIMARY KEY (id);


--
-- Name: campaign_recipients campaign_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_user_id_name_key UNIQUE (user_id, name);


--
-- Name: chat_assignments chat_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_assignments
    ADD CONSTRAINT chat_assignments_pkey PRIMARY KEY (id);


--
-- Name: chat_conversations chat_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_conversations
    ADD CONSTRAINT chat_conversations_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chatbot_corpus chatbot_corpus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chatbot_corpus
    ADD CONSTRAINT chatbot_corpus_pkey PRIMARY KEY (id);


--
-- Name: crm_account_invitations crm_account_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_invitations
    ADD CONSTRAINT crm_account_invitations_pkey PRIMARY KEY (id);


--
-- Name: crm_account_members crm_account_members_account_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_members
    ADD CONSTRAINT crm_account_members_account_id_user_id_key UNIQUE (account_id, user_id);


--
-- Name: crm_account_members crm_account_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_members
    ADD CONSTRAINT crm_account_members_pkey PRIMARY KEY (id);


--
-- Name: crm_accounts crm_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_accounts
    ADD CONSTRAINT crm_accounts_pkey PRIMARY KEY (id);


--
-- Name: crm_automation_logs crm_automation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_logs
    ADD CONSTRAINT crm_automation_logs_pkey PRIMARY KEY (id);


--
-- Name: crm_automation_nodes crm_automation_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_nodes
    ADD CONSTRAINT crm_automation_nodes_pkey PRIMARY KEY (id);


--
-- Name: crm_automations crm_automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automations
    ADD CONSTRAINT crm_automations_pkey PRIMARY KEY (id);


--
-- Name: crm_broadcast_recipients crm_broadcast_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_broadcast_recipients
    ADD CONSTRAINT crm_broadcast_recipients_pkey PRIMARY KEY (id);


--
-- Name: crm_broadcasts crm_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_broadcasts
    ADD CONSTRAINT crm_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: crm_canned_messages crm_canned_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_canned_messages
    ADD CONSTRAINT crm_canned_messages_pkey PRIMARY KEY (id);


--
-- Name: crm_contact_custom_values crm_contact_custom_values_contact_id_custom_field_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_custom_values
    ADD CONSTRAINT crm_contact_custom_values_contact_id_custom_field_id_key UNIQUE (contact_id, custom_field_id);


--
-- Name: crm_contact_custom_values crm_contact_custom_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_custom_values
    ADD CONSTRAINT crm_contact_custom_values_pkey PRIMARY KEY (id);


--
-- Name: crm_contact_notes crm_contact_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_notes
    ADD CONSTRAINT crm_contact_notes_pkey PRIMARY KEY (id);


--
-- Name: crm_contact_tags crm_contact_tags_contact_id_tag_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_tags
    ADD CONSTRAINT crm_contact_tags_contact_id_tag_id_key UNIQUE (contact_id, tag_id);


--
-- Name: crm_contact_tags crm_contact_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_tags
    ADD CONSTRAINT crm_contact_tags_pkey PRIMARY KEY (id);


--
-- Name: crm_contacts crm_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_pkey PRIMARY KEY (id);


--
-- Name: crm_conversations crm_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversations
    ADD CONSTRAINT crm_conversations_pkey PRIMARY KEY (id);


--
-- Name: crm_custom_fields crm_custom_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_custom_fields
    ADD CONSTRAINT crm_custom_fields_pkey PRIMARY KEY (id);


--
-- Name: crm_deals crm_deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_deals
    ADD CONSTRAINT crm_deals_pkey PRIMARY KEY (id);


--
-- Name: crm_flow_media crm_flow_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_media
    ADD CONSTRAINT crm_flow_media_pkey PRIMARY KEY (id);


--
-- Name: crm_flow_nodes crm_flow_nodes_flow_id_node_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_nodes
    ADD CONSTRAINT crm_flow_nodes_flow_id_node_key_key UNIQUE (flow_id, node_key);


--
-- Name: crm_flow_nodes crm_flow_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_nodes
    ADD CONSTRAINT crm_flow_nodes_pkey PRIMARY KEY (id);


--
-- Name: crm_flow_run_events crm_flow_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_run_events
    ADD CONSTRAINT crm_flow_run_events_pkey PRIMARY KEY (id);


--
-- Name: crm_flow_runs crm_flow_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_runs
    ADD CONSTRAINT crm_flow_runs_pkey PRIMARY KEY (id);


--
-- Name: crm_flows crm_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flows
    ADD CONSTRAINT crm_flows_pkey PRIMARY KEY (id);


--
-- Name: crm_message_reactions crm_message_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_message_reactions
    ADD CONSTRAINT crm_message_reactions_pkey PRIMARY KEY (id);


--
-- Name: crm_message_templates crm_message_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_message_templates
    ADD CONSTRAINT crm_message_templates_pkey PRIMARY KEY (id);


--
-- Name: crm_messages crm_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_messages
    ADD CONSTRAINT crm_messages_pkey PRIMARY KEY (id);


--
-- Name: crm_pipeline_stages crm_pipeline_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_pkey PRIMARY KEY (id);


--
-- Name: crm_pipelines crm_pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_pipelines
    ADD CONSTRAINT crm_pipelines_pkey PRIMARY KEY (id);


--
-- Name: crm_tags crm_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tags
    ADD CONSTRAINT crm_tags_pkey PRIMARY KEY (id);


--
-- Name: delivery_staff delivery_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_staff
    ADD CONSTRAINT delivery_staff_pkey PRIMARY KEY (id);


--
-- Name: food_store_settings food_store_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.food_store_settings
    ADD CONSTRAINT food_store_settings_pkey PRIMARY KEY (user_id);


--
-- Name: instagram_accounts instagram_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_accounts
    ADD CONSTRAINT instagram_accounts_pkey PRIMARY KEY (id);


--
-- Name: instagram_action_dispatch instagram_action_dispatch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_action_dispatch
    ADD CONSTRAINT instagram_action_dispatch_pkey PRIMARY KEY (id);


--
-- Name: instagram_ai_audit_configs instagram_ai_audit_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_ai_audit_configs
    ADD CONSTRAINT instagram_ai_audit_configs_pkey PRIMARY KEY (id);


--
-- Name: instagram_ai_audit_runs instagram_ai_audit_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_ai_audit_runs
    ADD CONSTRAINT instagram_ai_audit_runs_pkey PRIMARY KEY (id);


--
-- Name: instagram_ai_opportunities instagram_ai_opportunities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_ai_opportunities
    ADD CONSTRAINT instagram_ai_opportunities_pkey PRIMARY KEY (id);


--
-- Name: instagram_automation_rules instagram_automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_automation_rules
    ADD CONSTRAINT instagram_automation_rules_pkey PRIMARY KEY (id);


--
-- Name: instagram_deleted_messages instagram_deleted_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_deleted_messages
    ADD CONSTRAINT instagram_deleted_messages_pkey PRIMARY KEY (id);


--
-- Name: instagram_dm_logs instagram_dm_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_dm_logs
    ADD CONSTRAINT instagram_dm_logs_pkey PRIMARY KEY (id);


--
-- Name: instagram_rate_limit_config_history instagram_rate_limit_config_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_rate_limit_config_history
    ADD CONSTRAINT instagram_rate_limit_config_history_pkey PRIMARY KEY (id);


--
-- Name: instagram_rate_limit_config instagram_rate_limit_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_rate_limit_config
    ADD CONSTRAINT instagram_rate_limit_config_pkey PRIMARY KEY (id);


--
-- Name: instagram_tracked_link_clicks instagram_tracked_link_clicks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_tracked_link_clicks
    ADD CONSTRAINT instagram_tracked_link_clicks_pkey PRIMARY KEY (id);


--
-- Name: instagram_tracked_links instagram_tracked_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_tracked_links
    ADD CONSTRAINT instagram_tracked_links_pkey PRIMARY KEY (id);


--
-- Name: instagram_tracked_links instagram_tracked_links_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_tracked_links
    ADD CONSTRAINT instagram_tracked_links_slug_key UNIQUE (slug);


--
-- Name: instagram_webhook_events instagram_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_webhook_events
    ADD CONSTRAINT instagram_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: journey_instances journey_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_instances
    ADD CONSTRAINT journey_instances_pkey PRIMARY KEY (id);


--
-- Name: knowledge_chunks knowledge_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id);


--
-- Name: knowledge_documents knowledge_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_pkey PRIMARY KEY (id);


--
-- Name: languages languages_language_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.languages
    ADD CONSTRAINT languages_language_code_key UNIQUE (language_code);


--
-- Name: languages languages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.languages
    ADD CONSTRAINT languages_pkey PRIMARY KEY (id);


--
-- Name: llm_models llm_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_models
    ADD CONSTRAINT llm_models_pkey PRIMARY KEY (id);


--
-- Name: menu_items menu_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_pkey PRIMARY KEY (id);


--
-- Name: menus menus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menus
    ADD CONSTRAINT menus_pkey PRIMARY KEY (id);


--
-- Name: minutes_transactions minutes_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.minutes_transactions
    ADD CONSTRAINT minutes_transactions_pkey PRIMARY KEY (id);


--
-- Name: omnidim_call_logs omnidim_call_logs_omnidim_call_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_call_logs
    ADD CONSTRAINT omnidim_call_logs_omnidim_call_id_key UNIQUE (omnidim_call_id);


--
-- Name: omnidim_call_logs omnidim_call_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_call_logs
    ADD CONSTRAINT omnidim_call_logs_pkey PRIMARY KEY (id);


--
-- Name: omnidim_campaigns omnidim_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_campaigns
    ADD CONSTRAINT omnidim_campaigns_pkey PRIMARY KEY (id);


--
-- Name: omnidim_contacts omnidim_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_contacts
    ADD CONSTRAINT omnidim_contacts_pkey PRIMARY KEY (id);


--
-- Name: omnidim_custom_integrations omnidim_custom_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_custom_integrations
    ADD CONSTRAINT omnidim_custom_integrations_pkey PRIMARY KEY (id);


--
-- Name: omnidim_custom_integrations omnidim_custom_integrations_user_id_type_url_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_custom_integrations
    ADD CONSTRAINT omnidim_custom_integrations_user_id_type_url_slug_key UNIQUE (user_id, type, url_slug);


--
-- Name: order_events order_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_pkey PRIMARY KEY (id);


--
-- Name: orders orders_custom_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_custom_order_id_key UNIQUE (custom_order_id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: orders orders_user_id_short_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_short_code_key UNIQUE (user_id, short_code);


--
-- Name: organization_configurations organization_configurations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_configurations
    ADD CONSTRAINT organization_configurations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_provider_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_provider_id_key UNIQUE (provider_id);


--
-- Name: platform_config platform_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_config
    ADD CONSTRAINT platform_config_pkey PRIMARY KEY (id);


--
-- Name: platform_uber_settings platform_uber_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_uber_settings
    ADD CONSTRAINT platform_uber_settings_pkey PRIMARY KEY (id);


--
-- Name: platform_voice_config platform_voice_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_voice_config
    ADD CONSTRAINT platform_voice_config_pkey PRIMARY KEY (id);


--
-- Name: platform_voice_config platform_voice_config_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_voice_config
    ADD CONSTRAINT platform_voice_config_provider_key UNIQUE (provider);


--
-- Name: platform_voice_profiles platform_voice_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_voice_profiles
    ADD CONSTRAINT platform_voice_profiles_pkey PRIMARY KEY (id);


--
-- Name: platform_voice_settings platform_voice_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_voice_settings
    ADD CONSTRAINT platform_voice_settings_pkey PRIMARY KEY (id);


--
-- Name: platform_whatsapp_ai_config platform_whatsapp_ai_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_whatsapp_ai_config
    ADD CONSTRAINT platform_whatsapp_ai_config_pkey PRIMARY KEY (id);


--
-- Name: platform_whatsapp_settings platform_whatsapp_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_whatsapp_settings
    ADD CONSTRAINT platform_whatsapp_settings_pkey PRIMARY KEY (id);


--
-- Name: pricing_plans_history pricing_plans_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_plans_history
    ADD CONSTRAINT pricing_plans_history_pkey PRIMARY KEY (id);


--
-- Name: pricing_plans pricing_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_plans
    ADD CONSTRAINT pricing_plans_pkey PRIMARY KEY (id);


--
-- Name: public_api_keys public_api_keys_api_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_api_keys
    ADD CONSTRAINT public_api_keys_api_key_key UNIQUE (api_key);


--
-- Name: public_api_keys public_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_api_keys
    ADD CONSTRAINT public_api_keys_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_log reconciliation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_log
    ADD CONSTRAINT reconciliation_log_pkey PRIMARY KEY (id);


--
-- Name: restaurants restaurants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT restaurants_pkey PRIMARY KEY (id);


--
-- Name: sales_crm_leads sales_crm_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_crm_leads
    ADD CONSTRAINT sales_crm_leads_pkey PRIMARY KEY (id);


--
-- Name: scheduled_followups scheduled_followups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_followups
    ADD CONSTRAINT scheduled_followups_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: tag_to_agent_configs tag_to_agent_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_to_agent_configs
    ADD CONSTRAINT tag_to_agent_configs_pkey PRIMARY KEY (id);


--
-- Name: tag_to_agent_configs tag_to_agent_workspace_tag_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_to_agent_configs
    ADD CONSTRAINT tag_to_agent_workspace_tag_unique UNIQUE (workspace_id, tag_id);


--
-- Name: telecaller_sessions telecaller_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telecaller_sessions
    ADD CONSTRAINT telecaller_sessions_pkey PRIMARY KEY (id);


--
-- Name: telecaller_shifts telecaller_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telecaller_shifts
    ADD CONSTRAINT telecaller_shifts_pkey PRIMARY KEY (id);


--
-- Name: telecallers telecallers_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telecallers
    ADD CONSTRAINT telecallers_email_key UNIQUE (email);


--
-- Name: telecallers telecallers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telecallers
    ADD CONSTRAINT telecallers_pkey PRIMARY KEY (id);


--
-- Name: templates templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.templates
    ADD CONSTRAINT templates_pkey PRIMARY KEY (id);


--
-- Name: tenant_ai_settings tenant_ai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ai_settings
    ADD CONSTRAINT tenant_ai_settings_pkey PRIMARY KEY (id);


--
-- Name: tenant_ai_settings tenant_ai_settings_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ai_settings
    ADD CONSTRAINT tenant_ai_settings_tenant_id_key UNIQUE (tenant_id);


--
-- Name: tenant_config tenant_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_config
    ADD CONSTRAINT tenant_config_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_users tenant_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_pkey PRIMARY KEY (id);


--
-- Name: tenant_whatsapp_config tenant_whatsapp_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_whatsapp_config
    ADD CONSTRAINT tenant_whatsapp_config_pkey PRIMARY KEY (id);


--
-- Name: tenant_whatsapp_config tenant_whatsapp_config_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_whatsapp_config
    ADD CONSTRAINT tenant_whatsapp_config_tenant_id_key UNIQUE (tenant_id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);


--
-- Name: tool_configuration tool_configuration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_configuration
    ADD CONSTRAINT tool_configuration_pkey PRIMARY KEY (id);


--
-- Name: tool_configuration tool_configuration_tool_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_configuration
    ADD CONSTRAINT tool_configuration_tool_unique UNIQUE (tool_id);


--
-- Name: tool_execution_logs tool_execution_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_execution_logs
    ADD CONSTRAINT tool_execution_logs_pkey PRIMARY KEY (id);


--
-- Name: triggered_calls triggered_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggered_calls
    ADD CONSTRAINT triggered_calls_pkey PRIMARY KEY (id);


--
-- Name: uber_deliveries uber_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_deliveries
    ADD CONSTRAINT uber_deliveries_pkey PRIMARY KEY (id);


--
-- Name: uber_deliveries uber_deliveries_public_tracking_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_deliveries
    ADD CONSTRAINT uber_deliveries_public_tracking_token_key UNIQUE (public_tracking_token);


--
-- Name: uber_deliveries uber_deliveries_uber_delivery_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_deliveries
    ADD CONSTRAINT uber_deliveries_uber_delivery_id_key UNIQUE (uber_delivery_id);


--
-- Name: uber_delivery_webhook_events uber_delivery_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_delivery_webhook_events
    ADD CONSTRAINT uber_delivery_webhook_events_pkey PRIMARY KEY (event_id);


--
-- Name: uber_integrations uber_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_integrations
    ADD CONSTRAINT uber_integrations_pkey PRIMARY KEY (id);


--
-- Name: uber_integrations uber_integrations_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_integrations
    ADD CONSTRAINT uber_integrations_user_id_key UNIQUE (user_id);


--
-- Name: uber_pickup_locations uber_pickup_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_pickup_locations
    ADD CONSTRAINT uber_pickup_locations_pkey PRIMARY KEY (id);


--
-- Name: uber_pickup_locations uber_pickup_locations_restaurant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_pickup_locations
    ADD CONSTRAINT uber_pickup_locations_restaurant_id_key UNIQUE (restaurant_id);


--
-- Name: omnidim_contacts unique_campaign_phone; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_contacts
    ADD CONSTRAINT unique_campaign_phone UNIQUE (campaign_id, phone_number);


--
-- Name: chat_conversations unique_tenant_contact; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_conversations
    ADD CONSTRAINT unique_tenant_contact UNIQUE (tenant_id, contact_id);


--
-- Name: workspace_invitations unique_tenant_email_invite; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT unique_tenant_email_invite UNIQUE (tenant_id, email);


--
-- Name: instagram_accounts unique_tenant_ig_account; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_accounts
    ADD CONSTRAINT unique_tenant_ig_account UNIQUE (tenant_id, ig_account_id);


--
-- Name: workspace_roles unique_tenant_role_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_roles
    ADD CONSTRAINT unique_tenant_role_name UNIQUE (tenant_id, name);


--
-- Name: whatsapp_templates unique_tenant_template_language; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_templates
    ADD CONSTRAINT unique_tenant_template_language UNIQUE (tenant_id, template_name, language_code);


--
-- Name: call_logs uq_call_logs_room_id_constraint; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT uq_call_logs_room_id_constraint UNIQUE (room_id);


--
-- Name: crm_canned_messages uq_crm_canned_messages_user_shortcut; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_canned_messages
    ADD CONSTRAINT uq_crm_canned_messages_user_shortcut UNIQUE (user_id, shortcut);


--
-- Name: instagram_action_dispatch uq_ig_action_dispatch_dedup; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_action_dispatch
    ADD CONSTRAINT uq_ig_action_dispatch_dedup UNIQUE (tenant_id, dedup_key);


--
-- Name: instagram_ai_audit_configs uq_ig_ai_audit_config_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_ai_audit_configs
    ADD CONSTRAINT uq_ig_ai_audit_config_scope UNIQUE (tenant_id, ig_account_id);


--
-- Name: instagram_ai_opportunities uq_ig_ai_opportunity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_ai_opportunities
    ADD CONSTRAINT uq_ig_ai_opportunity UNIQUE (tenant_id, ig_account_id, conversation_key, target_id);


--
-- Name: instagram_dm_logs uq_ig_logs_tenant_mid; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_dm_logs
    ADD CONSTRAINT uq_ig_logs_tenant_mid UNIQUE (tenant_id, message_id);


--
-- Name: instagram_rate_limit_config uq_ig_rate_limit_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_rate_limit_config
    ADD CONSTRAINT uq_ig_rate_limit_scope UNIQUE (tenant_id, ig_account_id, action_type);


--
-- Name: sales_crm_leads uq_sales_crm_leads_user_phone; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_crm_leads
    ADD CONSTRAINT uq_sales_crm_leads_user_phone UNIQUE (user_id, customer_phone);


--
-- Name: tenants uq_tenants_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT uq_tenants_slug UNIQUE (slug);


--
-- Name: wallet_transactions uq_wallet_transactions_payment_ref; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT uq_wallet_transactions_payment_ref UNIQUE (payment_ref);


--
-- Name: whatsapp_accounts uq_whatsapp_accounts_user_phone_number_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_accounts
    ADD CONSTRAINT uq_whatsapp_accounts_user_phone_number_id UNIQUE (user_id, phone_number_id);


--
-- Name: user_google_calendar_connections user_google_calendar_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_google_calendar_connections
    ADD CONSTRAINT user_google_calendar_connections_pkey PRIMARY KEY (id);


--
-- Name: user_google_calendar_connections user_google_calendar_connections_tenant_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_google_calendar_connections
    ADD CONSTRAINT user_google_calendar_connections_tenant_key UNIQUE (tenant_id);


--
-- Name: user_inbound_agents user_inbound_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_inbound_agents
    ADD CONSTRAINT user_inbound_agents_pkey PRIMARY KEY (id);


--
-- Name: user_inbound_agents user_inbound_agents_user_id_agent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_inbound_agents
    ADD CONSTRAINT user_inbound_agents_user_id_agent_id_key UNIQUE (user_id, agent_id);


--
-- Name: user_outbound_agents user_outbound_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_outbound_agents
    ADD CONSTRAINT user_outbound_agents_pkey PRIMARY KEY (id);


--
-- Name: user_push_subscriptions user_push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_push_subscriptions
    ADD CONSTRAINT user_push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: user_push_subscriptions user_push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_push_subscriptions
    ADD CONSTRAINT user_push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: user_voice_config user_voice_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_config
    ADD CONSTRAINT user_voice_config_pkey PRIMARY KEY (id);


--
-- Name: user_voice_config user_voice_config_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_config
    ADD CONSTRAINT user_voice_config_user_id_key UNIQUE (user_id);


--
-- Name: user_voice_phone_numbers user_voice_phone_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_phone_numbers
    ADD CONSTRAINT user_voice_phone_numbers_pkey PRIMARY KEY (id);


--
-- Name: user_voice_phone_numbers user_voice_phone_numbers_user_id_phone_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_phone_numbers
    ADD CONSTRAINT user_voice_phone_numbers_user_id_phone_number_key UNIQUE (user_id, phone_number);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vobiz_call_jobs vobiz_call_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_call_jobs
    ADD CONSTRAINT vobiz_call_jobs_pkey PRIMARY KEY (id);


--
-- Name: vobiz_call_logs vobiz_call_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_call_logs
    ADD CONSTRAINT vobiz_call_logs_pkey PRIMARY KEY (id);


--
-- Name: vobiz_campaigns vobiz_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_campaigns
    ADD CONSTRAINT vobiz_campaigns_pkey PRIMARY KEY (id);


--
-- Name: vobiz_credential_audit vobiz_credential_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_credential_audit
    ADD CONSTRAINT vobiz_credential_audit_pkey PRIMARY KEY (id);


--
-- Name: vobiz_credentials vobiz_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_credentials
    ADD CONSTRAINT vobiz_credentials_pkey PRIMARY KEY (id);


--
-- Name: voice_profiles voice_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_profiles
    ADD CONSTRAINT voice_profiles_pkey PRIMARY KEY (id);


--
-- Name: wallet_transactions wallet_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_pkey PRIMARY KEY (id);


--
-- Name: webhook_events webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_accounts whatsapp_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_form_submissions whatsapp_form_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_form_submissions
    ADD CONSTRAINT whatsapp_form_submissions_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_forms whatsapp_forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_forms
    ADD CONSTRAINT whatsapp_forms_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_messages whatsapp_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_templates whatsapp_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_templates
    ADD CONSTRAINT whatsapp_templates_pkey PRIMARY KEY (id);


--
-- Name: workspace_invitations workspace_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);


--
-- Name: workspace_invitations workspace_invitations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_token_key UNIQUE (token);


--
-- Name: workspace_members workspace_members_member_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_member_user_id_key UNIQUE (member_user_id);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (id);


--
-- Name: workspace_roles workspace_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_roles
    ADD CONSTRAINT workspace_roles_pkey PRIMARY KEY (id);


--
-- Name: idx_action_assets_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_assets_tenant ON public.agent_action_assets USING btree (tenant_id);


--
-- Name: idx_active_transfers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_active_transfers_status ON public.active_transfers USING btree (status) WHERE (status = ANY (ARRAY['RINGING'::text, 'CONNECTED'::text]));


--
-- Name: idx_active_transfers_telecaller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_active_transfers_telecaller ON public.active_transfers USING btree (telecaller_id);


--
-- Name: idx_active_transfers_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_active_transfers_user_id ON public.active_transfers USING btree (user_id);


--
-- Name: idx_agent_action_assets_embedding_v2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_action_assets_embedding_v2 ON public.agent_action_assets USING hnsw (embedding_v2 public.vector_cosine_ops);


--
-- Name: idx_agent_tool_assets_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tool_assets_tool ON public.agent_tool_assets USING btree (tool_id);


--
-- Name: idx_agent_tools_embedding_v2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tools_embedding_v2 ON public.agent_tools USING hnsw (embedding_v2 public.vector_cosine_ops);


--
-- Name: idx_agent_tools_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tools_enabled ON public.agent_tools USING btree (tenant_id, is_enabled) WHERE (is_enabled = true);


--
-- Name: idx_agent_tools_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tools_tenant ON public.agent_tools USING btree (tenant_id);


--
-- Name: idx_ai_usage_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_usage_created ON public.ai_usage_logs USING btree (created_at DESC);


--
-- Name: idx_ai_usage_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_usage_tenant ON public.ai_usage_logs USING btree (tenant_id);


--
-- Name: idx_blog_categories_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_categories_slug ON public.blog_categories USING btree (slug);


--
-- Name: idx_blog_post_categories_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_post_categories_cat ON public.blog_post_categories USING btree (category_id);


--
-- Name: idx_blog_post_categories_post; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_post_categories_post ON public.blog_post_categories USING btree (post_id);


--
-- Name: idx_blog_post_tags_post; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_post_tags_post ON public.blog_post_tags USING btree (post_id);


--
-- Name: idx_blog_post_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_post_tags_tag ON public.blog_post_tags USING btree (tag_id);


--
-- Name: idx_blog_posts_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_posts_author_id ON public.blog_posts USING btree (author_id);


--
-- Name: idx_blog_posts_is_featured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_posts_is_featured ON public.blog_posts USING btree (is_featured) WHERE (is_featured = true);


--
-- Name: idx_blog_posts_published_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_posts_published_at ON public.blog_posts USING btree (published_at DESC);


--
-- Name: idx_blog_posts_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_posts_slug ON public.blog_posts USING btree (slug);


--
-- Name: idx_blog_posts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_posts_status ON public.blog_posts USING btree (status);


--
-- Name: idx_blog_tags_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_tags_slug ON public.blog_tags USING btree (slug);


--
-- Name: idx_call_transcripts_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_job ON public.call_transcripts USING btree (call_job_id);


--
-- Name: idx_call_transcripts_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_phone ON public.call_transcripts USING btree (phone);


--
-- Name: idx_call_transcripts_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_room ON public.call_transcripts USING btree (call_room_id);


--
-- Name: idx_call_transcripts_room_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_room_seq ON public.call_transcripts USING btree (call_room_id, sequence_num);


--
-- Name: idx_call_transcripts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_tenant ON public.call_transcripts USING btree (tenant_id);


--
-- Name: idx_campaign_recipients_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_recipients_campaign_id ON public.campaign_recipients USING btree (campaign_id);


--
-- Name: idx_campaign_recipients_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_recipients_status ON public.campaign_recipients USING btree (status);


--
-- Name: idx_campaign_recipients_wa_msg_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_recipients_wa_msg_id ON public.campaign_recipients USING btree (wa_message_id);


--
-- Name: idx_campaigns_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaigns_user_id ON public.campaigns USING btree (user_id);


--
-- Name: idx_chat_conv_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_conv_contact ON public.chat_conversations USING btree (contact_id);


--
-- Name: idx_chat_conv_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_conv_tenant ON public.chat_conversations USING btree (tenant_id);


--
-- Name: idx_chat_conversations_summarization; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_conversations_summarization ON public.chat_conversations USING btree (id, last_summarized_at_count) WHERE (last_summarized_at_count > 0);


--
-- Name: idx_chat_msgs_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_msgs_conv ON public.chat_messages USING btree (conversation_id);


--
-- Name: idx_crm_account_members_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_account_members_account ON public.crm_account_members USING btree (account_id);


--
-- Name: idx_crm_account_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_account_members_user ON public.crm_account_members USING btree (user_id);


--
-- Name: idx_crm_automation_logs_automation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_automation_logs_automation ON public.crm_automation_logs USING btree (automation_id, created_at DESC);


--
-- Name: idx_crm_automation_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_automation_logs_user ON public.crm_automation_logs USING btree (user_id);


--
-- Name: idx_crm_automation_nodes_automation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_automation_nodes_automation ON public.crm_automation_nodes USING btree (automation_id);


--
-- Name: idx_crm_automation_nodes_unique_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crm_automation_nodes_unique_key ON public.crm_automation_nodes USING btree (automation_id, node_key);


--
-- Name: idx_crm_automations_active_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_automations_active_trigger ON public.crm_automations USING btree (trigger_type) WHERE (is_active = true);


--
-- Name: idx_crm_automations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_automations_user_id ON public.crm_automations USING btree (user_id);


--
-- Name: idx_crm_broadcast_recipients_broadcast; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_broadcast_recipients_broadcast ON public.crm_broadcast_recipients USING btree (broadcast_id);


--
-- Name: idx_crm_broadcast_recipients_wamid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_broadcast_recipients_wamid ON public.crm_broadcast_recipients USING btree (whatsapp_message_id) WHERE (whatsapp_message_id IS NOT NULL);


--
-- Name: idx_crm_broadcasts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_broadcasts_user ON public.crm_broadcasts USING btree (user_id);


--
-- Name: idx_crm_canned_messages_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_canned_messages_category ON public.crm_canned_messages USING btree (category);


--
-- Name: idx_crm_canned_messages_shortcut; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_canned_messages_shortcut ON public.crm_canned_messages USING btree (shortcut);


--
-- Name: idx_crm_canned_messages_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_canned_messages_user_id ON public.crm_canned_messages USING btree (user_id);


--
-- Name: idx_crm_contact_tags_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contact_tags_contact ON public.crm_contact_tags USING btree (contact_id);


--
-- Name: idx_crm_contact_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contact_tags_tag ON public.crm_contact_tags USING btree (tag_id);


--
-- Name: idx_crm_contacts_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contacts_assigned_to ON public.crm_contacts USING btree (assigned_to);


--
-- Name: idx_crm_contacts_call_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contacts_call_status ON public.crm_contacts USING btree (call_status);


--
-- Name: idx_crm_contacts_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contacts_phone ON public.crm_contacts USING btree (phone);


--
-- Name: idx_crm_contacts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contacts_user_id ON public.crm_contacts USING btree (user_id);


--
-- Name: idx_crm_contacts_user_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crm_contacts_user_phone ON public.crm_contacts USING btree (user_id, phone);


--
-- Name: idx_crm_conversations_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_conversations_contact_id ON public.crm_conversations USING btree (contact_id);


--
-- Name: idx_crm_conversations_cooldown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_conversations_cooldown ON public.crm_conversations USING btree (user_id, flow_cooldown_until) WHERE (flow_cooldown_until IS NOT NULL);


--
-- Name: idx_crm_conversations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_conversations_user_id ON public.crm_conversations USING btree (user_id);


--
-- Name: idx_crm_deals_pipeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_deals_pipeline ON public.crm_deals USING btree (pipeline_id);


--
-- Name: idx_crm_deals_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_deals_stage ON public.crm_deals USING btree (stage_id);


--
-- Name: idx_crm_deals_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_deals_user ON public.crm_deals USING btree (user_id);


--
-- Name: idx_crm_flow_media_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_flow_media_flow ON public.crm_flow_media USING btree (flow_id);


--
-- Name: idx_crm_flow_nodes_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_flow_nodes_flow ON public.crm_flow_nodes USING btree (flow_id);


--
-- Name: idx_crm_flow_run_events_run_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_flow_run_events_run_time ON public.crm_flow_run_events USING btree (flow_run_id, created_at DESC);


--
-- Name: idx_crm_flow_run_events_run_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_flow_run_events_run_type ON public.crm_flow_run_events USING btree (flow_run_id, event_type);


--
-- Name: idx_crm_flow_runs_active_advanced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_flow_runs_active_advanced ON public.crm_flow_runs USING btree (last_advanced_at) WHERE (status = 'active'::text);


--
-- Name: idx_crm_flow_runs_flow_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_flow_runs_flow_started ON public.crm_flow_runs USING btree (flow_id, started_at DESC);


--
-- Name: idx_crm_flow_runs_last_inbound_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_flow_runs_last_inbound_msg ON public.crm_flow_runs USING btree (last_inbound_message_id) WHERE (last_inbound_message_id IS NOT NULL);


--
-- Name: idx_crm_flows_active_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_flows_active_trigger ON public.crm_flows USING btree (user_id, trigger_type) WHERE (status = 'active'::text);


--
-- Name: idx_crm_invitations_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_invitations_account ON public.crm_account_invitations USING btree (account_id);


--
-- Name: idx_crm_invitations_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_invitations_token ON public.crm_account_invitations USING btree (token_hash);


--
-- Name: idx_crm_message_reactions_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_message_reactions_message ON public.crm_message_reactions USING btree (message_id);


--
-- Name: idx_crm_message_templates_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_message_templates_user ON public.crm_message_templates USING btree (user_id);


--
-- Name: idx_crm_messages_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_messages_conversation ON public.crm_messages USING btree (conversation_id);


--
-- Name: idx_crm_messages_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_messages_message_id ON public.crm_messages USING btree (message_id);


--
-- Name: idx_crm_messages_unique_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crm_messages_unique_message_id ON public.crm_messages USING btree (message_id) WHERE (message_id IS NOT NULL);


--
-- Name: idx_crm_one_active_run_per_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crm_one_active_run_per_contact ON public.crm_flow_runs USING btree (user_id, contact_id) WHERE (status = 'active'::text);


--
-- Name: idx_crm_pipeline_stages_pipeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_pipeline_stages_pipeline ON public.crm_pipeline_stages USING btree (pipeline_id);


--
-- Name: idx_crm_tags_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tags_user_id ON public.crm_tags USING btree (user_id);


--
-- Name: idx_delivery_staff_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_staff_driver_id ON public.delivery_staff USING btree (driver_id);


--
-- Name: idx_delivery_staff_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_delivery_staff_phone ON public.delivery_staff USING btree (phone);


--
-- Name: idx_delivery_staff_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_staff_user_id ON public.delivery_staff USING btree (user_id);


--
-- Name: idx_ig_accounts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_accounts_tenant ON public.instagram_accounts USING btree (tenant_id);


--
-- Name: idx_ig_action_dispatch_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_action_dispatch_created ON public.instagram_action_dispatch USING btree (tenant_id, created_at DESC);


--
-- Name: idx_ig_action_dispatch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_action_dispatch_status ON public.instagram_action_dispatch USING btree (tenant_id, ig_account_id, action_type, status);


--
-- Name: idx_ig_ai_audit_configs_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_ai_audit_configs_due ON public.instagram_ai_audit_configs USING btree (next_run_at) WHERE (enabled = true);


--
-- Name: idx_ig_ai_audit_runs_running; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_ai_audit_runs_running ON public.instagram_ai_audit_runs USING btree (heartbeat_at) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[]));


--
-- Name: idx_ig_ai_audit_runs_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_ai_audit_runs_scope ON public.instagram_ai_audit_runs USING btree (tenant_id, ig_account_id, created_at DESC);


--
-- Name: idx_ig_ai_opps_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_ai_opps_list ON public.instagram_ai_opportunities USING btree (tenant_id, ig_account_id, message_at DESC);


--
-- Name: idx_ig_ai_opps_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_ai_opps_target ON public.instagram_ai_opportunities USING btree (tenant_id, target_id, status);


--
-- Name: idx_ig_deleted_msgs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_deleted_msgs_tenant ON public.instagram_deleted_messages USING btree (tenant_id, message_id);


--
-- Name: idx_ig_link_clicks_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_link_clicks_link ON public.instagram_tracked_link_clicks USING btree (tracked_link_id, clicked_at);


--
-- Name: idx_ig_logs_acct_commenter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_acct_commenter ON public.instagram_dm_logs USING btree (ig_account_id, commenter_id, sent_at DESC);


--
-- Name: idx_ig_logs_card_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_card_template ON public.instagram_dm_logs USING btree (tenant_id, ig_account_id) WHERE (card_template IS NOT NULL);


--
-- Name: idx_ig_logs_conv_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_conv_key ON public.instagram_dm_logs USING btree (tenant_id, conversation_key, sent_at DESC);


--
-- Name: idx_ig_logs_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_dedup ON public.instagram_dm_logs USING btree (post_id, commenter_id, rule_id);


--
-- Name: idx_ig_logs_direction_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_direction_unread ON public.instagram_dm_logs USING btree (tenant_id, ig_account_id, direction, is_read) WHERE (((direction)::text = 'inbound'::text) AND (is_read = false));


--
-- Name: idx_ig_logs_inbox_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_inbox_list ON public.instagram_dm_logs USING btree (tenant_id, ig_account_id, is_deleted, sent_at DESC);


--
-- Name: idx_ig_logs_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_message_id ON public.instagram_dm_logs USING btree (message_id);


--
-- Name: idx_ig_logs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_tenant ON public.instagram_dm_logs USING btree (tenant_id);


--
-- Name: idx_ig_logs_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_logs_thread ON public.instagram_dm_logs USING btree (tenant_id, ig_account_id, commenter_id, is_deleted, sent_at);


--
-- Name: idx_ig_logs_unique_mid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ig_logs_unique_mid ON public.instagram_dm_logs USING btree (tenant_id, message_id) WHERE (message_id IS NOT NULL);


--
-- Name: idx_ig_rate_limit_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_rate_limit_lookup ON public.instagram_rate_limit_config USING btree (tenant_id, ig_account_id, action_type);


--
-- Name: idx_ig_rules_tenant_ig; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_rules_tenant_ig ON public.instagram_automation_rules USING btree (tenant_id, ig_account_id);


--
-- Name: idx_ig_rules_trigger_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_rules_trigger_type ON public.instagram_automation_rules USING btree (tenant_id, ig_account_id, trigger_type, is_active);


--
-- Name: idx_ig_tracked_links_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_tracked_links_rule ON public.instagram_tracked_links USING btree (tenant_id, rule_id);


--
-- Name: idx_ig_tracked_links_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_tracked_links_slug ON public.instagram_tracked_links USING btree (slug);


--
-- Name: idx_ig_webhooks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_webhooks_status ON public.instagram_webhook_events USING btree (processing_status);


--
-- Name: idx_ig_webhooks_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ig_webhooks_tenant ON public.instagram_webhook_events USING btree (tenant_id);


--
-- Name: idx_journey_instances_call_wait; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journey_instances_call_wait ON public.journey_instances USING btree (contact_id) WHERE ((status = 'waiting'::text) AND (wait_type = 'call_concluded'::text));


--
-- Name: idx_journey_instances_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journey_instances_campaign ON public.journey_instances USING btree (campaign_id, created_at DESC);


--
-- Name: idx_journey_instances_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_journey_instances_one_active ON public.journey_instances USING btree (automation_id, contact_id) WHERE (status = ANY (ARRAY['running'::text, 'waiting'::text]));


--
-- Name: idx_journey_instances_time_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journey_instances_time_due ON public.journey_instances USING btree (wait_until) WHERE ((status = 'waiting'::text) AND (wait_type = 'time'::text));


--
-- Name: idx_journey_instances_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_journey_instances_user_status ON public.journey_instances USING btree (user_id, status, created_at DESC);


--
-- Name: idx_knowledge_chunks_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunks_doc ON public.knowledge_chunks USING btree (document_id);


--
-- Name: idx_knowledge_chunks_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunks_embedding ON public.knowledge_chunks USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_knowledge_chunks_embedding_v2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunks_embedding_v2 ON public.knowledge_chunks USING hnsw (embedding_v2 public.vector_cosine_ops);


--
-- Name: idx_knowledge_chunks_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunks_tenant ON public.knowledge_chunks USING btree (tenant_id);


--
-- Name: idx_knowledge_docs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_docs_tenant ON public.knowledge_documents USING btree (tenant_id);


--
-- Name: idx_knowledge_documents_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_documents_tenant_id ON public.knowledge_documents USING btree (tenant_id);


--
-- Name: idx_languages_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_languages_active ON public.languages USING btree (is_active);


--
-- Name: idx_llm_models_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_llm_models_active ON public.llm_models USING btree (is_active);


--
-- Name: idx_menu_items_menu_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_menu_id ON public.menu_items USING btree (menu_id);


--
-- Name: idx_menu_items_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_sku ON public.menu_items USING btree (sku);


--
-- Name: idx_menu_items_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_user_id ON public.menu_items USING btree (user_id);


--
-- Name: idx_menus_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menus_restaurant_id ON public.menus USING btree (restaurant_id);


--
-- Name: idx_menus_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menus_user_id ON public.menus USING btree (user_id);


--
-- Name: idx_minutes_txns_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_minutes_txns_created ON public.minutes_transactions USING btree (created_at DESC);


--
-- Name: idx_minutes_txns_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_minutes_txns_user ON public.minutes_transactions USING btree (user_id);


--
-- Name: idx_omnidim_call_logs_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_call_logs_campaign_id ON public.omnidim_call_logs USING btree (campaign_id);


--
-- Name: idx_omnidim_call_logs_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_call_logs_contact_id ON public.omnidim_call_logs USING btree (contact_id);


--
-- Name: idx_omnidim_call_logs_omnidim_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_call_logs_omnidim_id ON public.omnidim_call_logs USING btree (omnidim_call_id);


--
-- Name: idx_omnidim_campaigns_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_campaigns_status ON public.omnidim_campaigns USING btree (status);


--
-- Name: idx_omnidim_campaigns_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_campaigns_user_id ON public.omnidim_campaigns USING btree (user_id);


--
-- Name: idx_omnidim_campaigns_webhook_integration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_campaigns_webhook_integration ON public.omnidim_campaigns USING btree (webhook_integration_id) WHERE (webhook_integration_id IS NOT NULL);


--
-- Name: idx_omnidim_contacts_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_contacts_campaign_id ON public.omnidim_contacts USING btree (campaign_id);


--
-- Name: idx_omnidim_contacts_next_call; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_contacts_next_call ON public.omnidim_contacts USING btree (next_call_at) WHERE (call_status = ANY (ARRAY['pending'::text, 'not_lifted'::text, 'callback_later'::text, 'voicemail'::text, 'no_answer'::text, 'busy'::text]));


--
-- Name: idx_omnidim_contacts_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_contacts_phone ON public.omnidim_contacts USING btree (phone_number);


--
-- Name: idx_omnidim_contacts_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_contacts_priority ON public.omnidim_contacts USING btree (priority_flag, next_call_at) WHERE ((priority_flag = true) AND (call_status = ANY (ARRAY['pending'::text, 'not_lifted'::text, 'callback_later'::text, 'bridged_failed'::text])));


--
-- Name: idx_omnidim_contacts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omnidim_contacts_status ON public.omnidim_contacts USING btree (call_status);


--
-- Name: idx_order_events_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_order_id ON public.order_events USING btree (order_id);


--
-- Name: idx_order_events_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_user_id ON public.order_events USING btree (user_id);


--
-- Name: idx_orders_customer_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_customer_phone ON public.orders USING btree (customer_phone);


--
-- Name: idx_orders_inhouse_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_inhouse_driver_id ON public.orders USING btree (inhouse_driver_id);


--
-- Name: idx_orders_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_id ON public.orders USING btree (restaurant_id);


--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.orders USING btree (status);


--
-- Name: idx_orders_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_user_id ON public.orders USING btree (user_id);


--
-- Name: idx_public_api_keys_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_public_api_keys_key ON public.public_api_keys USING btree (api_key);


--
-- Name: idx_push_subs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_user_id ON public.user_push_subscriptions USING btree (user_id);


--
-- Name: idx_restaurants_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurants_user_id ON public.restaurants USING btree (user_id);


--
-- Name: idx_sales_crm_leads_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_crm_leads_campaign_id ON public.sales_crm_leads USING btree (campaign_id);


--
-- Name: idx_sales_crm_leads_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_crm_leads_created_at ON public.sales_crm_leads USING btree (created_at DESC);


--
-- Name: idx_sales_crm_leads_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_crm_leads_user_id ON public.sales_crm_leads USING btree (user_id);


--
-- Name: idx_scheduled_followups_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_followups_status_time ON public.scheduled_followups USING btree (status, scheduled_at);


--
-- Name: idx_scheduled_followups_tenant_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_followups_tenant_phone ON public.scheduled_followups USING btree (tenant_id, contact_phone);


--
-- Name: idx_sessions_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_token_hash ON public.sessions USING btree (jwt_token_hash);


--
-- Name: idx_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_user_id ON public.sessions USING btree (user_id);


--
-- Name: idx_tag_to_agent_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tag_to_agent_lookup ON public.tag_to_agent_configs USING btree (workspace_id, tag_id, is_active);


--
-- Name: idx_tag_to_agent_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tag_to_agent_priority ON public.tag_to_agent_configs USING btree (workspace_id, is_active, priority DESC);


--
-- Name: idx_tas_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tas_tenant_id ON public.tenant_ai_settings USING btree (tenant_id);


--
-- Name: idx_telecaller_sessions_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telecaller_sessions_hash ON public.telecaller_sessions USING btree (jwt_token_hash);


--
-- Name: idx_telecaller_sessions_telecaller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telecaller_sessions_telecaller ON public.telecaller_sessions USING btree (telecaller_id);


--
-- Name: idx_telecaller_shifts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telecaller_shifts_user_id ON public.telecaller_shifts USING btree (user_id);


--
-- Name: idx_telecallers_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telecallers_available ON public.telecallers USING btree (is_available) WHERE (is_available = true);


--
-- Name: idx_telecallers_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telecallers_email ON public.telecallers USING btree (email);


--
-- Name: idx_telecallers_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telecallers_user_id ON public.telecallers USING btree (user_id);


--
-- Name: idx_templates_created_by_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_created_by_admin ON public.templates USING btree (created_by_admin);


--
-- Name: idx_templates_meta_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_templates_meta_admin ON public.templates USING btree (meta_template_id, created_by_admin) WHERE ((meta_template_id IS NOT NULL) AND (created_by_admin = true));


--
-- Name: idx_templates_meta_template_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_meta_template_id ON public.templates USING btree (meta_template_id);


--
-- Name: idx_templates_meta_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_templates_meta_tenant ON public.templates USING btree (meta_template_id, tenant_id) WHERE ((meta_template_id IS NOT NULL) AND (tenant_id IS NOT NULL));


--
-- Name: idx_templates_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_tenant_id ON public.templates USING btree (tenant_id);


--
-- Name: idx_tenant_ai_settings_active_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_ai_settings_active_flow ON public.tenant_ai_settings USING btree (active_flow_id) WHERE (active_flow_id IS NOT NULL);


--
-- Name: idx_tickets_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_assigned ON public.tickets USING btree (assigned_to);


--
-- Name: idx_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_status ON public.tickets USING btree (status) WHERE (status = ANY (ARRAY['OPEN'::text, 'IN_PROGRESS'::text]));


--
-- Name: idx_tickets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_user_id ON public.tickets USING btree (user_id);


--
-- Name: idx_tool_configuration_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_configuration_tool ON public.tool_configuration USING btree (tool_id);


--
-- Name: idx_tool_exec_logs_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_exec_logs_contact ON public.tool_execution_logs USING btree (tenant_id, contact_id);


--
-- Name: idx_tool_exec_logs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_exec_logs_tenant ON public.tool_execution_logs USING btree (tenant_id, executed_at DESC);


--
-- Name: idx_triggered_calls_omnidim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_triggered_calls_omnidim ON public.triggered_calls USING btree (omnidim_call_id);


--
-- Name: idx_triggered_calls_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_triggered_calls_phone ON public.triggered_calls USING btree (customer_phone);


--
-- Name: idx_triggered_calls_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_triggered_calls_user ON public.triggered_calls USING btree (user_id);


--
-- Name: idx_twc_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_twc_tenant_id ON public.tenant_whatsapp_config USING btree (tenant_id);


--
-- Name: idx_uber_deliveries_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uber_deliveries_order_id ON public.uber_deliveries USING btree (order_id);


--
-- Name: idx_uber_deliveries_public_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uber_deliveries_public_token ON public.uber_deliveries USING btree (public_tracking_token);


--
-- Name: idx_uber_deliveries_uber_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uber_deliveries_uber_id ON public.uber_deliveries USING btree (uber_delivery_id);


--
-- Name: idx_uber_deliveries_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uber_deliveries_user_id ON public.uber_deliveries USING btree (user_id);


--
-- Name: idx_uber_integrations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uber_integrations_user_id ON public.uber_integrations USING btree (user_id);


--
-- Name: idx_uber_pickup_locations_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uber_pickup_locations_restaurant_id ON public.uber_pickup_locations USING btree (restaurant_id);


--
-- Name: idx_uber_pickup_locations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uber_pickup_locations_user_id ON public.uber_pickup_locations USING btree (user_id);


--
-- Name: idx_uber_webhook_events_delivery_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uber_webhook_events_delivery_id ON public.uber_delivery_webhook_events USING btree (uber_delivery_id);


--
-- Name: idx_ugcc_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ugcc_tenant_id ON public.user_google_calendar_connections USING btree (tenant_id);


--
-- Name: idx_user_voice_phone_numbers_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_voice_phone_numbers_user ON public.user_voice_phone_numbers USING btree (user_id);


--
-- Name: idx_users_agency_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_agency_domain ON public.users USING btree (agency_domain);


--
-- Name: idx_users_agency_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_agency_id ON public.users USING btree (agency_id);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_role ON public.users USING btree (role);


--
-- Name: idx_vobiz_call_jobs_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_jobs_campaign_id ON public.vobiz_call_jobs USING btree (campaign_id);


--
-- Name: idx_vobiz_call_jobs_campaign_status_retry_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_jobs_campaign_status_retry_composite ON public.vobiz_call_jobs USING btree (campaign_id, status, next_retry_at) WHERE ((status <> 'completed'::public.call_job_status) AND (status <> 'failed'::public.call_job_status));


--
-- Name: idx_vobiz_call_jobs_next_retry_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_jobs_next_retry_at ON public.vobiz_call_jobs USING btree (next_retry_at);


--
-- Name: idx_vobiz_call_jobs_phone_hashed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_jobs_phone_hashed ON public.vobiz_call_jobs USING btree (phone_number_hashed);


--
-- Name: idx_vobiz_call_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_jobs_status ON public.vobiz_call_jobs USING btree (status);


--
-- Name: idx_vobiz_call_jobs_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_jobs_tenant_created ON public.vobiz_call_jobs USING btree (tenant_id, created_at DESC);


--
-- Name: idx_vobiz_call_jobs_tenant_created_at_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_jobs_tenant_created_at_composite ON public.vobiz_call_jobs USING btree (tenant_id, created_at DESC);


--
-- Name: idx_vobiz_call_jobs_tenant_status_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_jobs_tenant_status_composite ON public.vobiz_call_jobs USING btree (tenant_id, status);


--
-- Name: idx_vobiz_call_logs_analytics_covering; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_logs_analytics_covering ON public.vobiz_call_logs USING btree (tenant_id, campaign_id, call_status, start_time) INCLUDE (duration_seconds, sip_response_code);


--
-- Name: idx_vobiz_call_logs_call_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_logs_call_status ON public.vobiz_call_logs USING btree (call_status);


--
-- Name: idx_vobiz_call_logs_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_logs_campaign_id ON public.vobiz_call_logs USING btree (campaign_id);


--
-- Name: idx_vobiz_call_logs_campaign_status_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_logs_campaign_status_composite ON public.vobiz_call_logs USING btree (campaign_id, call_status);


--
-- Name: idx_vobiz_call_logs_start_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_logs_start_time ON public.vobiz_call_logs USING btree (start_time DESC);


--
-- Name: idx_vobiz_call_logs_tenant_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_logs_tenant_id_created_at ON public.vobiz_call_logs USING btree (tenant_id, created_at DESC);


--
-- Name: idx_vobiz_call_logs_tenant_start_time_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_logs_tenant_start_time_composite ON public.vobiz_call_logs USING btree (tenant_id, start_time DESC);


--
-- Name: idx_vobiz_call_logs_tenant_status_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_call_logs_tenant_status_composite ON public.vobiz_call_logs USING btree (tenant_id, call_status, start_time DESC);


--
-- Name: idx_vobiz_campaigns_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_created_at ON public.vobiz_campaigns USING btree (created_at DESC);


--
-- Name: idx_vobiz_campaigns_profile_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_profile_id ON public.vobiz_campaigns USING btree (profile_id) WHERE (profile_id IS NOT NULL);


--
-- Name: idx_vobiz_campaigns_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_status ON public.vobiz_campaigns USING btree (status);


--
-- Name: idx_vobiz_campaigns_summary_covering; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_summary_covering ON public.vobiz_campaigns USING btree (tenant_id, status) INCLUDE (phone_count, queued_count, completed_count, failed_count);


--
-- Name: idx_vobiz_campaigns_tenant_created_at_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_tenant_created_at_composite ON public.vobiz_campaigns USING btree (tenant_id, created_at DESC);


--
-- Name: idx_vobiz_campaigns_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_tenant_id ON public.vobiz_campaigns USING btree (tenant_id);


--
-- Name: idx_vobiz_campaigns_tenant_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_tenant_status_created ON public.vobiz_campaigns USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_vobiz_campaigns_tenant_status_created_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_tenant_status_created_composite ON public.vobiz_campaigns USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_vobiz_campaigns_tenant_status_with_stats; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_campaigns_tenant_status_with_stats ON public.vobiz_campaigns USING btree (tenant_id, status, updated_at DESC);


--
-- Name: idx_vobiz_credential_audit_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credential_audit_created_at ON public.vobiz_credential_audit USING btree (created_at DESC);


--
-- Name: idx_vobiz_credential_audit_credential_action_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credential_audit_credential_action_composite ON public.vobiz_credential_audit USING btree (credential_id, action, created_at DESC);


--
-- Name: idx_vobiz_credential_audit_credential_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credential_audit_credential_id ON public.vobiz_credential_audit USING btree (credential_id);


--
-- Name: idx_vobiz_credential_audit_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credential_audit_tenant_created ON public.vobiz_credential_audit USING btree (tenant_id, created_at DESC);


--
-- Name: idx_vobiz_credential_audit_tenant_created_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credential_audit_tenant_created_composite ON public.vobiz_credential_audit USING btree (tenant_id, created_at DESC);


--
-- Name: idx_vobiz_credential_audit_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credential_audit_tenant_id ON public.vobiz_credential_audit USING btree (tenant_id);


--
-- Name: idx_vobiz_credentials_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credentials_created_at ON public.vobiz_credentials USING btree (created_at DESC);


--
-- Name: idx_vobiz_credentials_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credentials_tenant_id ON public.vobiz_credentials USING btree (tenant_id) WHERE (is_deleted = false);


--
-- Name: idx_vobiz_credentials_tenant_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credentials_tenant_verified ON public.vobiz_credentials USING btree (tenant_id, verified) WHERE (is_deleted = false);


--
-- Name: idx_vobiz_credentials_tenant_verified_created_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vobiz_credentials_tenant_verified_created_composite ON public.vobiz_credentials USING btree (tenant_id, verified, created_at DESC) WHERE (is_deleted = false);


--
-- Name: idx_wa_accounts_phone_number_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_accounts_phone_number_id ON public.whatsapp_accounts USING btree (phone_number_id);


--
-- Name: idx_wa_accounts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_accounts_user_id ON public.whatsapp_accounts USING btree (user_id);


--
-- Name: idx_wa_messages_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_messages_campaign_id ON public.whatsapp_messages USING btree (campaign_id);


--
-- Name: idx_wa_messages_direction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_messages_direction ON public.whatsapp_messages USING btree (direction);


--
-- Name: idx_wa_messages_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_messages_from ON public.whatsapp_messages USING btree (from_number);


--
-- Name: idx_wa_messages_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_messages_tenant_id ON public.whatsapp_messages USING btree (tenant_id);


--
-- Name: idx_wa_messages_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_messages_timestamp ON public.whatsapp_messages USING btree ("timestamp" DESC);


--
-- Name: idx_wa_templates_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_templates_status ON public.whatsapp_templates USING btree (status);


--
-- Name: idx_wa_templates_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_templates_tenant_id ON public.whatsapp_templates USING btree (tenant_id);


--
-- Name: idx_webhook_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_events_created ON public.webhook_events USING btree (created_at DESC);


--
-- Name: idx_webhook_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_events_tenant ON public.webhook_events USING btree (tenant_id);


--
-- Name: idx_whatsapp_form_submissions_form; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_form_submissions_form ON public.whatsapp_form_submissions USING btree (form_id);


--
-- Name: idx_whatsapp_form_submissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_form_submissions_user ON public.whatsapp_form_submissions USING btree (user_id);


--
-- Name: idx_whatsapp_forms_meta_flow_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_forms_meta_flow_id ON public.whatsapp_forms USING btree (meta_flow_id);


--
-- Name: idx_whatsapp_forms_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_forms_user_id ON public.whatsapp_forms USING btree (user_id);


--
-- Name: idx_whatsapp_messages_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_messages_tenant_id ON public.whatsapp_messages USING btree (tenant_id);


--
-- Name: idx_workspace_invitations_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_invitations_tenant ON public.workspace_invitations USING btree (tenant_id);


--
-- Name: idx_workspace_invitations_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_invitations_token ON public.workspace_invitations USING btree (token);


--
-- Name: idx_workspace_members_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_members_tenant ON public.workspace_members USING btree (tenant_id);


--
-- Name: idx_workspace_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_members_user ON public.workspace_members USING btree (member_user_id);


--
-- Name: idx_workspace_roles_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_roles_tenant ON public.workspace_roles USING btree (tenant_id);


--
-- Name: ix_call_logs_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_call_logs_started_at ON public.call_logs USING btree (started_at);


--
-- Name: ix_call_logs_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_call_logs_tenant_id ON public.call_logs USING btree (tenant_id);


--
-- Name: ix_organization_configurations_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organization_configurations_id ON public.organization_configurations USING btree (id);


--
-- Name: ix_organization_configurations_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organization_configurations_organization_id ON public.organization_configurations USING btree (organization_id);


--
-- Name: ix_organizations_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organizations_id ON public.organizations USING btree (id);


--
-- Name: ix_organizations_provider_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_organizations_provider_id ON public.organizations USING btree (provider_id);


--
-- Name: ix_reconciliation_log_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_reconciliation_log_tenant_id ON public.reconciliation_log USING btree (tenant_id);


--
-- Name: ix_tenant_users_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tenant_users_tenant_id ON public.tenant_users USING btree (tenant_id);


--
-- Name: ix_wallet_transactions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_wallet_transactions_created_at ON public.wallet_transactions USING btree (created_at);


--
-- Name: ix_wallet_transactions_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_wallet_transactions_tenant_id ON public.wallet_transactions USING btree (tenant_id);


--
-- Name: platform_voice_settings_single_row_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX platform_voice_settings_single_row_idx ON public.platform_voice_settings USING btree ((true));


--
-- Name: platform_whatsapp_ai_config_single_row; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX platform_whatsapp_ai_config_single_row ON public.platform_whatsapp_ai_config USING btree ((true));


--
-- Name: unique_friendly_name_per_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_friendly_name_per_tenant ON public.vobiz_credentials USING btree (tenant_id, friendly_name) WHERE (is_deleted = false);


--
-- Name: uq_call_logs_room_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_call_logs_room_id ON public.call_logs USING btree (room_id) WHERE (room_id IS NOT NULL);


--
-- Name: users_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_unique ON public.users USING btree (lower(email));


--
-- Name: crm_canned_messages crm_canned_messages_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_canned_messages_updated_at BEFORE UPDATE ON public.crm_canned_messages FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: crm_accounts crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.crm_accounts FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: crm_automations crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.crm_automations FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: crm_broadcasts crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.crm_broadcasts FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: crm_contacts crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.crm_contacts FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: crm_conversations crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.crm_conversations FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: crm_deals crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.crm_deals FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: crm_flows crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.crm_flows FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: crm_message_templates crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.crm_message_templates FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: tag_to_agent_configs crm_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_set_updated_at BEFORE UPDATE ON public.tag_to_agent_configs FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: journey_instances journey_instances_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER journey_instances_set_updated_at BEFORE UPDATE ON public.journey_instances FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at_column();


--
-- Name: user_push_subscriptions push_subscriptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER push_subscriptions_updated_at BEFORE UPDATE ON public.user_push_subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_push_subscription_timestamp();


--
-- Name: crm_contacts sync_crm_contact_to_sales_crm_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_crm_contact_to_sales_crm_trigger AFTER INSERT OR UPDATE ON public.crm_contacts FOR EACH ROW EXECUTE FUNCTION public.sync_crm_contact_to_sales_crm();


--
-- Name: whatsapp_messages trg_sync_whatsapp_message_to_crm; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_whatsapp_message_to_crm AFTER INSERT ON public.whatsapp_messages FOR EACH ROW EXECUTE FUNCTION public.sync_whatsapp_message_to_crm();


--
-- Name: whatsapp_messages trg_sync_whatsapp_status_to_crm; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_whatsapp_status_to_crm AFTER UPDATE OF status, error_message ON public.whatsapp_messages FOR EACH ROW EXECUTE FUNCTION public.sync_whatsapp_status_to_crm();


--
-- Name: active_transfers active_transfers_telecaller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_transfers
    ADD CONSTRAINT active_transfers_telecaller_id_fkey FOREIGN KEY (telecaller_id) REFERENCES public.telecallers(id) ON DELETE CASCADE;


--
-- Name: active_transfers active_transfers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_transfers
    ADD CONSTRAINT active_transfers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: admin_audit_logs admin_audit_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_logs
    ADD CONSTRAINT admin_audit_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: admin_audit_logs admin_audit_logs_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_logs
    ADD CONSTRAINT admin_audit_logs_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: agent_action_assets agent_action_assets_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_action_assets
    ADD CONSTRAINT agent_action_assets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_tool_assets agent_tool_assets_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_assets
    ADD CONSTRAINT agent_tool_assets_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.agent_tools(id) ON DELETE CASCADE;


--
-- Name: agent_tools agent_tools_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_tools agent_tools_version_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_version_parent_id_fkey FOREIGN KEY (version_parent_id) REFERENCES public.agent_tools(id) ON DELETE SET NULL;


--
-- Name: ai_usage_logs ai_usage_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_logs
    ADD CONSTRAINT ai_usage_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: blog_post_categories blog_post_categories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_post_categories
    ADD CONSTRAINT blog_post_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.blog_categories(id) ON DELETE CASCADE;


--
-- Name: blog_post_categories blog_post_categories_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_post_categories
    ADD CONSTRAINT blog_post_categories_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.blog_posts(id) ON DELETE CASCADE;


--
-- Name: blog_post_tags blog_post_tags_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_post_tags
    ADD CONSTRAINT blog_post_tags_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.blog_posts(id) ON DELETE CASCADE;


--
-- Name: blog_post_tags blog_post_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_post_tags
    ADD CONSTRAINT blog_post_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.blog_tags(id) ON DELETE CASCADE;


--
-- Name: blog_posts blog_posts_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_posts
    ADD CONSTRAINT blog_posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: campaign_recipients campaign_recipients_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_recipients
    ADD CONSTRAINT campaign_recipients_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_assignments chat_assignments_agent_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_assignments
    ADD CONSTRAINT chat_assignments_agent_user_id_fkey FOREIGN KEY (agent_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chat_assignments chat_assignments_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_assignments
    ADD CONSTRAINT chat_assignments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.chat_conversations(id) ON DELETE CASCADE;


--
-- Name: chat_conversations chat_conversations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_conversations
    ADD CONSTRAINT chat_conversations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.chat_conversations(id) ON DELETE CASCADE;


--
-- Name: crm_account_invitations crm_account_invitations_accepted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_invitations
    ADD CONSTRAINT crm_account_invitations_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_account_invitations crm_account_invitations_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_invitations
    ADD CONSTRAINT crm_account_invitations_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.crm_accounts(id) ON DELETE CASCADE;


--
-- Name: crm_account_invitations crm_account_invitations_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_invitations
    ADD CONSTRAINT crm_account_invitations_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_account_members crm_account_members_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_members
    ADD CONSTRAINT crm_account_members_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.crm_accounts(id) ON DELETE CASCADE;


--
-- Name: crm_account_members crm_account_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_members
    ADD CONSTRAINT crm_account_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_accounts crm_accounts_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_accounts
    ADD CONSTRAINT crm_accounts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_automation_logs crm_automation_logs_automation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_logs
    ADD CONSTRAINT crm_automation_logs_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.crm_automations(id) ON DELETE CASCADE;


--
-- Name: crm_automation_logs crm_automation_logs_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_logs
    ADD CONSTRAINT crm_automation_logs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE SET NULL;


--
-- Name: crm_automation_logs crm_automation_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_logs
    ADD CONSTRAINT crm_automation_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_automation_nodes crm_automation_nodes_automation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_nodes
    ADD CONSTRAINT crm_automation_nodes_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.crm_automations(id) ON DELETE CASCADE;


--
-- Name: crm_automations crm_automations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automations
    ADD CONSTRAINT crm_automations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_broadcast_recipients crm_broadcast_recipients_broadcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_broadcast_recipients
    ADD CONSTRAINT crm_broadcast_recipients_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES public.crm_broadcasts(id) ON DELETE CASCADE;


--
-- Name: crm_broadcast_recipients crm_broadcast_recipients_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_broadcast_recipients
    ADD CONSTRAINT crm_broadcast_recipients_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE SET NULL;


--
-- Name: crm_broadcasts crm_broadcasts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_broadcasts
    ADD CONSTRAINT crm_broadcasts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_canned_messages crm_canned_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_canned_messages
    ADD CONSTRAINT crm_canned_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_contact_custom_values crm_contact_custom_values_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_custom_values
    ADD CONSTRAINT crm_contact_custom_values_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE CASCADE;


--
-- Name: crm_contact_custom_values crm_contact_custom_values_custom_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_custom_values
    ADD CONSTRAINT crm_contact_custom_values_custom_field_id_fkey FOREIGN KEY (custom_field_id) REFERENCES public.crm_custom_fields(id) ON DELETE CASCADE;


--
-- Name: crm_contact_notes crm_contact_notes_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_notes
    ADD CONSTRAINT crm_contact_notes_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE CASCADE;


--
-- Name: crm_contact_notes crm_contact_notes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_notes
    ADD CONSTRAINT crm_contact_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_contact_tags crm_contact_tags_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_tags
    ADD CONSTRAINT crm_contact_tags_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE CASCADE;


--
-- Name: crm_contact_tags crm_contact_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_tags
    ADD CONSTRAINT crm_contact_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.crm_tags(id) ON DELETE CASCADE;


--
-- Name: crm_contacts crm_contacts_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_contacts crm_contacts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_conversations crm_conversations_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversations
    ADD CONSTRAINT crm_conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE CASCADE;


--
-- Name: crm_conversations crm_conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversations
    ADD CONSTRAINT crm_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_custom_fields crm_custom_fields_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_custom_fields
    ADD CONSTRAINT crm_custom_fields_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_deals crm_deals_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_deals
    ADD CONSTRAINT crm_deals_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_deals crm_deals_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_deals
    ADD CONSTRAINT crm_deals_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE SET NULL;


--
-- Name: crm_deals crm_deals_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_deals
    ADD CONSTRAINT crm_deals_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.crm_conversations(id);


--
-- Name: crm_deals crm_deals_pipeline_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_deals
    ADD CONSTRAINT crm_deals_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES public.crm_pipelines(id) ON DELETE CASCADE;


--
-- Name: crm_deals crm_deals_stage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_deals
    ADD CONSTRAINT crm_deals_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES public.crm_pipeline_stages(id);


--
-- Name: crm_deals crm_deals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_deals
    ADD CONSTRAINT crm_deals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_flow_media crm_flow_media_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_media
    ADD CONSTRAINT crm_flow_media_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.crm_flows(id) ON DELETE CASCADE;


--
-- Name: crm_flow_nodes crm_flow_nodes_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_nodes
    ADD CONSTRAINT crm_flow_nodes_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.crm_flows(id) ON DELETE CASCADE;


--
-- Name: crm_flow_run_events crm_flow_run_events_flow_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_run_events
    ADD CONSTRAINT crm_flow_run_events_flow_run_id_fkey FOREIGN KEY (flow_run_id) REFERENCES public.crm_flow_runs(id) ON DELETE CASCADE;


--
-- Name: crm_flow_runs crm_flow_runs_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_runs
    ADD CONSTRAINT crm_flow_runs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE SET NULL;


--
-- Name: crm_flow_runs crm_flow_runs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_runs
    ADD CONSTRAINT crm_flow_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.crm_conversations(id) ON DELETE SET NULL;


--
-- Name: crm_flow_runs crm_flow_runs_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_runs
    ADD CONSTRAINT crm_flow_runs_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.crm_flows(id) ON DELETE CASCADE;


--
-- Name: crm_flow_runs crm_flow_runs_last_prompt_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_runs
    ADD CONSTRAINT crm_flow_runs_last_prompt_message_id_fkey FOREIGN KEY (last_prompt_message_id) REFERENCES public.crm_messages(id) ON DELETE SET NULL;


--
-- Name: crm_flow_runs crm_flow_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flow_runs
    ADD CONSTRAINT crm_flow_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_flows crm_flows_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_flows
    ADD CONSTRAINT crm_flows_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_message_reactions crm_message_reactions_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_message_reactions
    ADD CONSTRAINT crm_message_reactions_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.crm_conversations(id) ON DELETE CASCADE;


--
-- Name: crm_message_reactions crm_message_reactions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_message_reactions
    ADD CONSTRAINT crm_message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.crm_messages(id) ON DELETE CASCADE;


--
-- Name: crm_message_templates crm_message_templates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_message_templates
    ADD CONSTRAINT crm_message_templates_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_messages crm_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_messages
    ADD CONSTRAINT crm_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.crm_conversations(id) ON DELETE CASCADE;


--
-- Name: crm_pipeline_stages crm_pipeline_stages_pipeline_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES public.crm_pipelines(id) ON DELETE CASCADE;


--
-- Name: crm_pipelines crm_pipelines_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_pipelines
    ADD CONSTRAINT crm_pipelines_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_tags crm_tags_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tags
    ADD CONSTRAINT crm_tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: delivery_staff delivery_staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_staff
    ADD CONSTRAINT delivery_staff_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: call_logs fk_call_logs_campaign_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT fk_call_logs_campaign_id FOREIGN KEY (campaign_id) REFERENCES public.vobiz_campaigns(id) ON DELETE SET NULL;


--
-- Name: call_logs fk_call_logs_tenant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT fk_call_logs_tenant FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: call_transcripts fk_call_transcripts_tenant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_transcripts
    ADD CONSTRAINT fk_call_transcripts_tenant FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reconciliation_log fk_reconciliation_log_tenant_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_log
    ADD CONSTRAINT fk_reconciliation_log_tenant_id FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: sales_crm_leads fk_sales_crm_ai_call_log; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_crm_leads
    ADD CONSTRAINT fk_sales_crm_ai_call_log FOREIGN KEY (ai_call_log_id) REFERENCES public.omnidim_call_logs(id) ON DELETE SET NULL;


--
-- Name: sales_crm_leads fk_sales_crm_campaign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_crm_leads
    ADD CONSTRAINT fk_sales_crm_campaign FOREIGN KEY (campaign_id) REFERENCES public.omnidim_campaigns(id) ON DELETE SET NULL;


--
-- Name: tenant_ai_settings fk_tenant_ai_settings_tenant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ai_settings
    ADD CONSTRAINT fk_tenant_ai_settings_tenant FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tenant_config fk_tenant_config_active_language; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_config
    ADD CONSTRAINT fk_tenant_config_active_language FOREIGN KEY (active_language_id) REFERENCES public.languages(id);


--
-- Name: tenant_config fk_tenant_config_active_model; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_config
    ADD CONSTRAINT fk_tenant_config_active_model FOREIGN KEY (active_model_id) REFERENCES public.llm_models(id);


--
-- Name: tenant_config fk_tenant_config_tenant_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_config
    ADD CONSTRAINT fk_tenant_config_tenant_id FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: vobiz_call_jobs fk_tenant_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_call_jobs
    ADD CONSTRAINT fk_tenant_id FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tenant_users fk_tenant_users_tenant_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT fk_tenant_users_tenant_id FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: wallet_transactions fk_wallet_transactions_tenant_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT fk_wallet_transactions_tenant_id FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: food_store_settings food_store_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.food_store_settings
    ADD CONSTRAINT food_store_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: instagram_action_dispatch instagram_action_dispatch_related_dm_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_action_dispatch
    ADD CONSTRAINT instagram_action_dispatch_related_dm_log_id_fkey FOREIGN KEY (related_dm_log_id) REFERENCES public.instagram_dm_logs(id) ON DELETE SET NULL;


--
-- Name: instagram_ai_audit_runs instagram_ai_audit_runs_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_ai_audit_runs
    ADD CONSTRAINT instagram_ai_audit_runs_config_id_fkey FOREIGN KEY (config_id) REFERENCES public.instagram_ai_audit_configs(id) ON DELETE CASCADE;


--
-- Name: instagram_ai_opportunities instagram_ai_opportunities_last_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_ai_opportunities
    ADD CONSTRAINT instagram_ai_opportunities_last_run_id_fkey FOREIGN KEY (last_run_id) REFERENCES public.instagram_ai_audit_runs(id) ON DELETE SET NULL;


--
-- Name: instagram_dm_logs instagram_dm_logs_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_dm_logs
    ADD CONSTRAINT instagram_dm_logs_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.instagram_automation_rules(id) ON DELETE SET NULL;


--
-- Name: instagram_tracked_link_clicks instagram_tracked_link_clicks_tracked_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_tracked_link_clicks
    ADD CONSTRAINT instagram_tracked_link_clicks_tracked_link_id_fkey FOREIGN KEY (tracked_link_id) REFERENCES public.instagram_tracked_links(id) ON DELETE CASCADE;


--
-- Name: instagram_tracked_links instagram_tracked_links_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_tracked_links
    ADD CONSTRAINT instagram_tracked_links_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.instagram_automation_rules(id) ON DELETE CASCADE;


--
-- Name: instagram_webhook_events instagram_webhook_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_webhook_events
    ADD CONSTRAINT instagram_webhook_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: journey_instances journey_instances_automation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_instances
    ADD CONSTRAINT journey_instances_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.crm_automations(id) ON DELETE CASCADE;


--
-- Name: journey_instances journey_instances_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_instances
    ADD CONSTRAINT journey_instances_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.omnidim_campaigns(id) ON DELETE SET NULL;


--
-- Name: journey_instances journey_instances_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_instances
    ADD CONSTRAINT journey_instances_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE SET NULL;


--
-- Name: journey_instances journey_instances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journey_instances
    ADD CONSTRAINT journey_instances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: knowledge_chunks knowledge_chunks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.knowledge_documents(id) ON DELETE CASCADE;


--
-- Name: knowledge_chunks knowledge_chunks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: knowledge_documents knowledge_documents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: menu_items menu_items_menu_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_menu_id_fkey FOREIGN KEY (menu_id) REFERENCES public.menus(id) ON DELETE CASCADE;


--
-- Name: menu_items menu_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: menus menus_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menus
    ADD CONSTRAINT menus_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: menus menus_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menus
    ADD CONSTRAINT menus_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: minutes_transactions minutes_transactions_performed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.minutes_transactions
    ADD CONSTRAINT minutes_transactions_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES public.users(id);


--
-- Name: minutes_transactions minutes_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.minutes_transactions
    ADD CONSTRAINT minutes_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: omnidim_call_logs omnidim_call_logs_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_call_logs
    ADD CONSTRAINT omnidim_call_logs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.omnidim_campaigns(id) ON DELETE CASCADE;


--
-- Name: omnidim_call_logs omnidim_call_logs_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_call_logs
    ADD CONSTRAINT omnidim_call_logs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.omnidim_contacts(id) ON DELETE SET NULL;


--
-- Name: omnidim_campaigns omnidim_campaigns_journey_automation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_campaigns
    ADD CONSTRAINT omnidim_campaigns_journey_automation_id_fkey FOREIGN KEY (journey_automation_id) REFERENCES public.crm_automations(id) ON DELETE SET NULL;


--
-- Name: omnidim_campaigns omnidim_campaigns_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_campaigns
    ADD CONSTRAINT omnidim_campaigns_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: omnidim_campaigns omnidim_campaigns_voice_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_campaigns
    ADD CONSTRAINT omnidim_campaigns_voice_profile_id_fkey FOREIGN KEY (voice_profile_id) REFERENCES public.voice_profiles(id) ON DELETE SET NULL;


--
-- Name: omnidim_campaigns omnidim_campaigns_webhook_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_campaigns
    ADD CONSTRAINT omnidim_campaigns_webhook_integration_id_fkey FOREIGN KEY (webhook_integration_id) REFERENCES public.omnidim_custom_integrations(id) ON DELETE SET NULL;


--
-- Name: omnidim_contacts omnidim_contacts_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_contacts
    ADD CONSTRAINT omnidim_contacts_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.omnidim_campaigns(id) ON DELETE CASCADE;


--
-- Name: omnidim_contacts omnidim_contacts_source_webhook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_contacts
    ADD CONSTRAINT omnidim_contacts_source_webhook_id_fkey FOREIGN KEY (source_webhook_id) REFERENCES public.omnidim_custom_integrations(id) ON DELETE SET NULL;


--
-- Name: omnidim_custom_integrations omnidim_custom_integrations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omnidim_custom_integrations
    ADD CONSTRAINT omnidim_custom_integrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: order_events order_events_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_events order_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: orders orders_inhouse_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_inhouse_driver_id_fkey FOREIGN KEY (inhouse_driver_id) REFERENCES public.delivery_staff(id) ON DELETE SET NULL;


--
-- Name: orders orders_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE SET NULL;


--
-- Name: orders orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: organization_configurations organization_configurations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_configurations
    ADD CONSTRAINT organization_configurations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: platform_uber_settings platform_uber_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_uber_settings
    ADD CONSTRAINT platform_uber_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: platform_voice_settings platform_voice_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_voice_settings
    ADD CONSTRAINT platform_voice_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: platform_whatsapp_ai_config platform_whatsapp_ai_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_whatsapp_ai_config
    ADD CONSTRAINT platform_whatsapp_ai_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: platform_whatsapp_settings platform_whatsapp_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_whatsapp_settings
    ADD CONSTRAINT platform_whatsapp_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: pricing_plans_history pricing_plans_history_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_plans_history
    ADD CONSTRAINT pricing_plans_history_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: public_api_keys public_api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_api_keys
    ADD CONSTRAINT public_api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: restaurants restaurants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT restaurants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sales_crm_leads sales_crm_leads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_crm_leads
    ADD CONSTRAINT sales_crm_leads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: scheduled_followups scheduled_followups_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_followups
    ADD CONSTRAINT scheduled_followups_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE SET NULL;


--
-- Name: scheduled_followups scheduled_followups_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_followups
    ADD CONSTRAINT scheduled_followups_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.crm_conversations(id) ON DELETE SET NULL;


--
-- Name: scheduled_followups scheduled_followups_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_followups
    ADD CONSTRAINT scheduled_followups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tag_to_agent_configs tag_to_agent_configs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_to_agent_configs
    ADD CONSTRAINT tag_to_agent_configs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.crm_flows(id) ON DELETE CASCADE;


--
-- Name: tag_to_agent_configs tag_to_agent_configs_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_to_agent_configs
    ADD CONSTRAINT tag_to_agent_configs_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.crm_tags(id) ON DELETE CASCADE;


--
-- Name: tag_to_agent_configs tag_to_agent_configs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_to_agent_configs
    ADD CONSTRAINT tag_to_agent_configs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: telecaller_sessions telecaller_sessions_telecaller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telecaller_sessions
    ADD CONSTRAINT telecaller_sessions_telecaller_id_fkey FOREIGN KEY (telecaller_id) REFERENCES public.telecallers(id) ON DELETE CASCADE;


--
-- Name: telecaller_shifts telecaller_shifts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telecaller_shifts
    ADD CONSTRAINT telecaller_shifts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: telecallers telecallers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telecallers
    ADD CONSTRAINT telecallers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: templates templates_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.templates
    ADD CONSTRAINT templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tenant_ai_settings tenant_ai_settings_active_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ai_settings
    ADD CONSTRAINT tenant_ai_settings_active_flow_id_fkey FOREIGN KEY (active_flow_id) REFERENCES public.crm_flows(id) ON DELETE SET NULL;


--
-- Name: tenant_ai_settings tenant_ai_settings_active_provider_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_ai_settings
    ADD CONSTRAINT tenant_ai_settings_active_provider_fkey FOREIGN KEY (active_provider) REFERENCES public.ai_providers(name) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: tenant_whatsapp_config tenant_whatsapp_config_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_whatsapp_config
    ADD CONSTRAINT tenant_whatsapp_config_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tickets tickets_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.telecallers(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.omnidim_campaigns(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.omnidim_contacts(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tool_configuration tool_configuration_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_configuration
    ADD CONSTRAINT tool_configuration_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.agent_tools(id) ON DELETE CASCADE;


--
-- Name: tool_execution_logs tool_execution_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_execution_logs
    ADD CONSTRAINT tool_execution_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: triggered_calls triggered_calls_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggered_calls
    ADD CONSTRAINT triggered_calls_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.public_api_keys(id);


--
-- Name: triggered_calls triggered_calls_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.triggered_calls
    ADD CONSTRAINT triggered_calls_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: uber_deliveries uber_deliveries_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_deliveries
    ADD CONSTRAINT uber_deliveries_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: uber_deliveries uber_deliveries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_deliveries
    ADD CONSTRAINT uber_deliveries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: uber_integrations uber_integrations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_integrations
    ADD CONSTRAINT uber_integrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: uber_pickup_locations uber_pickup_locations_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_pickup_locations
    ADD CONSTRAINT uber_pickup_locations_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: uber_pickup_locations uber_pickup_locations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uber_pickup_locations
    ADD CONSTRAINT uber_pickup_locations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_google_calendar_connections user_google_calendar_connections_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_google_calendar_connections
    ADD CONSTRAINT user_google_calendar_connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_inbound_agents user_inbound_agents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_inbound_agents
    ADD CONSTRAINT user_inbound_agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_outbound_agents user_outbound_agents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_outbound_agents
    ADD CONSTRAINT user_outbound_agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_voice_config user_voice_config_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_config
    ADD CONSTRAINT user_voice_config_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_voice_phone_numbers user_voice_phone_numbers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_voice_phone_numbers
    ADD CONSTRAINT user_voice_phone_numbers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_agency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: users users_onboarded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_onboarded_by_fkey FOREIGN KEY (onboarded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vobiz_call_jobs vobiz_call_jobs_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_call_jobs
    ADD CONSTRAINT vobiz_call_jobs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.vobiz_campaigns(id) ON DELETE CASCADE;


--
-- Name: vobiz_call_logs vobiz_call_logs_call_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_call_logs
    ADD CONSTRAINT vobiz_call_logs_call_job_id_fkey FOREIGN KEY (call_job_id) REFERENCES public.vobiz_call_jobs(id) ON DELETE CASCADE;


--
-- Name: vobiz_call_logs vobiz_call_logs_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_call_logs
    ADD CONSTRAINT vobiz_call_logs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.vobiz_campaigns(id) ON DELETE CASCADE;


--
-- Name: vobiz_call_logs vobiz_call_logs_credential_set_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_call_logs
    ADD CONSTRAINT vobiz_call_logs_credential_set_id_fkey FOREIGN KEY (credential_set_id) REFERENCES public.vobiz_credentials(id) ON DELETE SET NULL;


--
-- Name: vobiz_call_logs vobiz_call_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_call_logs
    ADD CONSTRAINT vobiz_call_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vobiz_campaigns vobiz_campaigns_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_campaigns
    ADD CONSTRAINT vobiz_campaigns_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vobiz_campaigns vobiz_campaigns_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_campaigns
    ADD CONSTRAINT vobiz_campaigns_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.vobiz_credentials(id) ON DELETE RESTRICT;


--
-- Name: vobiz_campaigns vobiz_campaigns_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_campaigns
    ADD CONSTRAINT vobiz_campaigns_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vobiz_credential_audit vobiz_credential_audit_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_credential_audit
    ADD CONSTRAINT vobiz_credential_audit_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.vobiz_credentials(id) ON DELETE CASCADE;


--
-- Name: vobiz_credential_audit vobiz_credential_audit_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_credential_audit
    ADD CONSTRAINT vobiz_credential_audit_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vobiz_credential_audit vobiz_credential_audit_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_credential_audit
    ADD CONSTRAINT vobiz_credential_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vobiz_credentials vobiz_credentials_deleted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_credentials
    ADD CONSTRAINT vobiz_credentials_deleted_by_user_id_fkey FOREIGN KEY (deleted_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vobiz_credentials vobiz_credentials_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vobiz_credentials
    ADD CONSTRAINT vobiz_credentials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: voice_profiles voice_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_profiles
    ADD CONSTRAINT voice_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: webhook_events webhook_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_accounts whatsapp_accounts_crm_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_crm_flow_id_fkey FOREIGN KEY (crm_flow_id) REFERENCES public.crm_flows(id) ON DELETE SET NULL;


--
-- Name: whatsapp_accounts whatsapp_accounts_knowledge_base_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.knowledge_documents(id) ON DELETE SET NULL;


--
-- Name: whatsapp_accounts whatsapp_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_form_submissions whatsapp_form_submissions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_form_submissions
    ADD CONSTRAINT whatsapp_form_submissions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.crm_contacts(id) ON DELETE SET NULL;


--
-- Name: whatsapp_form_submissions whatsapp_form_submissions_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_form_submissions
    ADD CONSTRAINT whatsapp_form_submissions_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.whatsapp_forms(id) ON DELETE CASCADE;


--
-- Name: whatsapp_form_submissions whatsapp_form_submissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_form_submissions
    ADD CONSTRAINT whatsapp_form_submissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_forms whatsapp_forms_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_forms
    ADD CONSTRAINT whatsapp_forms_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_messages whatsapp_messages_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL;


--
-- Name: whatsapp_messages whatsapp_messages_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_templates whatsapp_templates_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_templates
    ADD CONSTRAINT whatsapp_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_invitations workspace_invitations_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.workspace_roles(id) ON DELETE SET NULL;


--
-- Name: workspace_invitations workspace_invitations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.workspace_roles(id) ON DELETE SET NULL;


--
-- Name: workspace_members workspace_members_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_roles workspace_roles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_roles
    ADD CONSTRAINT workspace_roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: platform_whatsapp_ai_config Allow service role full access to platform_whatsapp_ai_config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow service role full access to platform_whatsapp_ai_config" ON public.platform_whatsapp_ai_config USING (true);


--
-- Name: voice_profiles Authenticated users can view active voice profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view active voice profiles" ON public.voice_profiles FOR SELECT USING (true);


--
-- Name: workspace_invitations Owners can manage own invitations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can manage own invitations" ON public.workspace_invitations USING ((auth.uid() = tenant_id));


--
-- Name: workspace_members Owners can manage own members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can manage own members" ON public.workspace_members USING ((auth.uid() = tenant_id));


--
-- Name: workspace_roles Owners can manage own roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can manage own roles" ON public.workspace_roles USING ((auth.uid() = tenant_id));


--
-- Name: workspace_invitations Owners can view own invitations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can view own invitations" ON public.workspace_invitations FOR SELECT USING ((auth.uid() = tenant_id));


--
-- Name: workspace_members Owners can view own members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can view own members" ON public.workspace_members FOR SELECT USING ((auth.uid() = tenant_id));


--
-- Name: workspace_roles Owners can view own roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can view own roles" ON public.workspace_roles FOR SELECT USING ((auth.uid() = tenant_id));


--
-- Name: chatbot_corpus Public can read chatbot corpus; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read chatbot corpus" ON public.chatbot_corpus FOR SELECT USING (true);


--
-- Name: ai_providers Public can view AI providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can view AI providers" ON public.ai_providers FOR SELECT USING (true);


--
-- Name: blog_categories Public can view blog categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can view blog categories" ON public.blog_categories FOR SELECT USING (true);


--
-- Name: blog_post_categories Public can view blog post categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can view blog post categories" ON public.blog_post_categories FOR SELECT USING (true);


--
-- Name: blog_post_tags Public can view blog post tags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can view blog post tags" ON public.blog_post_tags FOR SELECT USING (true);


--
-- Name: blog_tags Public can view blog tags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can view blog tags" ON public.blog_tags FOR SELECT USING (true);


--
-- Name: pricing_plans Public can view pricing plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can view pricing plans" ON public.pricing_plans FOR SELECT USING (true);


--
-- Name: blog_posts Public can view published blog posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can view published blog posts" ON public.blog_posts FOR SELECT USING ((status = 'published'::text));


--
-- Name: chatbot_corpus Service role can modify corpus; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can modify corpus" ON public.chatbot_corpus USING (true) WITH CHECK (true);


--
-- Name: instagram_webhook_events Tenants can view own webhook events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenants can view own webhook events" ON public.instagram_webhook_events FOR SELECT USING ((auth.tenant_id() = tenant_id));


--
-- Name: user_inbound_agents Users can manage own inbound agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage own inbound agents" ON public.user_inbound_agents TO authenticated USING (((user_id = auth.tenant_id()) OR (user_id = auth.uid()))) WITH CHECK (((user_id = auth.tenant_id()) OR (user_id = auth.uid())));


--
-- Name: user_voice_phone_numbers Users can manage their own phone numbers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own phone numbers" ON public.user_voice_phone_numbers TO service_role, authenticated USING (true) WITH CHECK (true);


--
-- Name: user_push_subscriptions Users can manage their own push subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own push subscriptions" ON public.user_push_subscriptions USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: active_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.active_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: active_transfers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.active_transfers ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_action_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_action_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_action_assets agent_action_assets_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_action_assets_tenant_isolation ON public.agent_action_assets TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: agent_tool_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_tool_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_tool_assets agent_tool_assets_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_tool_assets_tenant_isolation ON public.agent_tool_assets TO authenticated USING ((tool_id IN ( SELECT agent_tools.id
   FROM public.agent_tools
  WHERE (agent_tools.tenant_id = auth.tenant_id())))) WITH CHECK ((tool_id IN ( SELECT agent_tools.id
   FROM public.agent_tools
  WHERE (agent_tools.tenant_id = auth.tenant_id()))));


--
-- Name: agent_tools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_tools agent_tools_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_tools_tenant_isolation ON public.agent_tools TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: ai_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage_logs ai_usage_logs_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_usage_logs_tenant_isolation ON public.ai_usage_logs TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: alembic_version; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alembic_version ENABLE ROW LEVEL SECURITY;

--
-- Name: blog_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blog_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: blog_post_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blog_post_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: blog_post_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blog_post_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: blog_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: blog_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blog_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: call_transcripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_transcripts ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_recipients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_recipients ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_recipients campaign_recipients_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY campaign_recipients_user_isolation ON public.campaign_recipients TO authenticated USING ((campaign_id IN ( SELECT campaigns.id
   FROM public.campaigns
  WHERE (campaigns.user_id = auth.tenant_id())))) WITH CHECK ((campaign_id IN ( SELECT campaigns.id
   FROM public.campaigns
  WHERE (campaigns.user_id = auth.tenant_id()))));


--
-- Name: campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: campaigns campaigns_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY campaigns_user_isolation ON public.campaigns TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: chat_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_assignments chat_assignments_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chat_assignments_tenant_isolation ON public.chat_assignments TO authenticated USING ((conversation_id IN ( SELECT chat_conversations.id
   FROM public.chat_conversations
  WHERE (chat_conversations.tenant_id = auth.tenant_id())))) WITH CHECK ((conversation_id IN ( SELECT chat_conversations.id
   FROM public.chat_conversations
  WHERE (chat_conversations.tenant_id = auth.tenant_id()))));


--
-- Name: chat_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_conversations chat_conversations_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chat_conversations_tenant_isolation ON public.chat_conversations TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: chat_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages chat_messages_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chat_messages_tenant_isolation ON public.chat_messages TO authenticated USING ((conversation_id IN ( SELECT chat_conversations.id
   FROM public.chat_conversations
  WHERE (chat_conversations.tenant_id = auth.tenant_id())))) WITH CHECK ((conversation_id IN ( SELECT chat_conversations.id
   FROM public.chat_conversations
  WHERE (chat_conversations.tenant_id = auth.tenant_id()))));


--
-- Name: chatbot_corpus; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chatbot_corpus ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_automations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_automations ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_automations crm_automations_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_automations_user_isolation ON public.crm_automations TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: crm_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_contacts crm_contacts_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_contacts_user_isolation ON public.crm_contacts TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: crm_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_conversations crm_conversations_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_conversations_user_isolation ON public.crm_conversations TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: crm_deals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_deals ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_deals crm_deals_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_deals_user_isolation ON public.crm_deals TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: crm_flows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_flows ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_flows crm_flows_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_flows_user_isolation ON public.crm_flows TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: crm_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_messages crm_messages_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_messages_user_isolation ON public.crm_messages TO authenticated USING ((conversation_id IN ( SELECT crm_conversations.id
   FROM public.crm_conversations
  WHERE (crm_conversations.user_id = auth.tenant_id())))) WITH CHECK ((conversation_id IN ( SELECT crm_conversations.id
   FROM public.crm_conversations
  WHERE (crm_conversations.user_id = auth.tenant_id()))));


--
-- Name: crm_pipelines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_pipelines ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_pipelines crm_pipelines_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_pipelines_user_isolation ON public.crm_pipelines TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: delivery_staff; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_staff ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_staff delivery_staff_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_staff_service_role ON public.delivery_staff TO service_role USING (true) WITH CHECK (true);


--
-- Name: delivery_staff delivery_staff_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_staff_user_isolation ON public.delivery_staff TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: food_store_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.food_store_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: food_store_settings food_store_settings_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY food_store_settings_user_isolation ON public.food_store_settings TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: instagram_ai_audit_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instagram_ai_audit_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: instagram_ai_audit_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instagram_ai_audit_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: instagram_ai_opportunities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instagram_ai_opportunities ENABLE ROW LEVEL SECURITY;

--
-- Name: instagram_webhook_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instagram_webhook_events ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge_chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge_chunks knowledge_chunks_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY knowledge_chunks_tenant_isolation ON public.knowledge_chunks TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: knowledge_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge_documents knowledge_documents_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY knowledge_documents_tenant_isolation ON public.knowledge_documents TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: legacy_call_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.legacy_call_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: menu_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;

--
-- Name: menu_items menu_items_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menu_items_user_isolation ON public.menu_items TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: menus; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menus ENABLE ROW LEVEL SECURITY;

--
-- Name: menus menus_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menus_user_isolation ON public.menus TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: minutes_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.minutes_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: minutes_transactions minutes_transactions_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY minutes_transactions_user_isolation ON public.minutes_transactions TO authenticated USING (((user_id = auth.tenant_id()) OR (user_id = auth.uid()))) WITH CHECK (((user_id = auth.tenant_id()) OR (user_id = auth.uid())));


--
-- Name: omnidim_call_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.omnidim_call_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: omnidim_call_logs omnidim_call_logs_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY omnidim_call_logs_user_isolation ON public.omnidim_call_logs TO authenticated USING (((campaign_id IN ( SELECT omnidim_campaigns.id
   FROM public.omnidim_campaigns
  WHERE (omnidim_campaigns.user_id = auth.tenant_id()))) OR ((campaign_id IS NULL) AND (((raw_payload ->> 'bot_id'::text) IN ( SELECT user_inbound_agents.agent_id
   FROM public.user_inbound_agents
  WHERE (user_inbound_agents.user_id = auth.tenant_id()))) OR ((raw_payload ->> 'agent_id'::text) IN ( SELECT user_inbound_agents.agent_id
   FROM public.user_inbound_agents
  WHERE (user_inbound_agents.user_id = auth.tenant_id()))) OR ((raw_payload ->> 'inbound_agent_id'::text) IN ( SELECT user_inbound_agents.agent_id
   FROM public.user_inbound_agents
  WHERE (user_inbound_agents.user_id = auth.tenant_id()))) OR (((raw_payload -> 'bot'::text) ->> 'id'::text) IN ( SELECT user_inbound_agents.agent_id
   FROM public.user_inbound_agents
  WHERE (user_inbound_agents.user_id = auth.tenant_id()))) OR (((raw_payload -> 'agent'::text) ->> 'id'::text) IN ( SELECT user_inbound_agents.agent_id
   FROM public.user_inbound_agents
  WHERE (user_inbound_agents.user_id = auth.tenant_id()))) OR ((raw_payload ->> 'bot_id'::text) IN ( SELECT user_voice_config.inbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id())
UNION
 SELECT user_voice_config.outbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id()))) OR ((raw_payload ->> 'agent_id'::text) IN ( SELECT user_voice_config.inbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id())
UNION
 SELECT user_voice_config.outbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id()))) OR ((raw_payload ->> 'inbound_agent_id'::text) IN ( SELECT user_voice_config.inbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id())
UNION
 SELECT user_voice_config.outbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id()))) OR (((raw_payload -> 'bot'::text) ->> 'id'::text) IN ( SELECT user_voice_config.inbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id())
UNION
 SELECT user_voice_config.outbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id()))) OR (((raw_payload -> 'agent'::text) ->> 'id'::text) IN ( SELECT user_voice_config.inbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id())
UNION
 SELECT user_voice_config.outbound_agent_id
   FROM public.user_voice_config
  WHERE (user_voice_config.user_id = auth.tenant_id())))))));


--
-- Name: omnidim_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.omnidim_campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: omnidim_campaigns omnidim_campaigns_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY omnidim_campaigns_user_isolation ON public.omnidim_campaigns TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: omnidim_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.omnidim_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: omnidim_contacts omnidim_contacts_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY omnidim_contacts_user_isolation ON public.omnidim_contacts TO authenticated USING ((campaign_id IN ( SELECT omnidim_campaigns.id
   FROM public.omnidim_campaigns
  WHERE (omnidim_campaigns.user_id = auth.tenant_id())))) WITH CHECK ((campaign_id IN ( SELECT omnidim_campaigns.id
   FROM public.omnidim_campaigns
  WHERE (omnidim_campaigns.user_id = auth.tenant_id()))));


--
-- Name: omnidim_custom_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.omnidim_custom_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: omnidim_custom_integrations omnidim_custom_integrations_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY omnidim_custom_integrations_user_isolation ON public.omnidim_custom_integrations TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: order_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;

--
-- Name: order_events order_events_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_events_user_isolation ON public.order_events TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: orders orders_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_user_isolation ON public.orders TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: platform_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_uber_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_uber_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_uber_settings platform_uber_settings_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_uber_settings_isolation ON public.platform_uber_settings USING (false) WITH CHECK (false);


--
-- Name: platform_voice_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_voice_config ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_whatsapp_ai_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_whatsapp_ai_config ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_whatsapp_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_whatsapp_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_plans_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_plans_history ENABLE ROW LEVEL SECURITY;

--
-- Name: public_api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.public_api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: public_api_keys public_api_keys_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_api_keys_user_isolation ON public.public_api_keys TO authenticated USING (((user_id = auth.tenant_id()) OR (user_id = auth.uid()))) WITH CHECK (((user_id = auth.tenant_id()) OR (user_id = auth.uid())));


--
-- Name: reconciliation_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reconciliation_log ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurants restaurants_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY restaurants_user_isolation ON public.restaurants TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: telecaller_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telecaller_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: telecaller_sessions telecaller_sessions_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY telecaller_sessions_user_isolation ON public.telecaller_sessions TO authenticated USING ((telecaller_id IN ( SELECT telecallers.id
   FROM public.telecallers
  WHERE (telecallers.user_id = auth.tenant_id())))) WITH CHECK ((telecaller_id IN ( SELECT telecallers.id
   FROM public.telecallers
  WHERE (telecallers.user_id = auth.tenant_id()))));


--
-- Name: telecaller_shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telecaller_shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: telecaller_shifts telecaller_shifts_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY telecaller_shifts_user_isolation ON public.telecaller_shifts TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: telecallers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telecallers ENABLE ROW LEVEL SECURITY;

--
-- Name: telecallers telecallers_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY telecallers_user_isolation ON public.telecallers TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;

--
-- Name: templates templates_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY templates_tenant_isolation ON public.templates TO authenticated USING (((tenant_id = auth.tenant_id()) OR (tenant_id IS NULL))) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: tenant_ai_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_ai_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_ai_settings tenant_ai_settings_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_ai_settings_tenant_isolation ON public.tenant_ai_settings TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: tenant_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_config ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_config tenant_config_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_config_tenant_isolation ON public.tenant_config TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: tenant_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_users tenant_users_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_users_tenant_isolation ON public.tenant_users TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: tenant_whatsapp_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_whatsapp_config ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_whatsapp_config tenant_whatsapp_config_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_whatsapp_config_tenant_isolation ON public.tenant_whatsapp_config TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: tenants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: triggered_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.triggered_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: triggered_calls triggered_calls_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY triggered_calls_user_isolation ON public.triggered_calls TO authenticated USING (((user_id = auth.tenant_id()) OR (user_id = auth.uid()))) WITH CHECK (((user_id = auth.tenant_id()) OR (user_id = auth.uid())));


--
-- Name: uber_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.uber_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: uber_deliveries uber_deliveries_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY uber_deliveries_user_isolation ON public.uber_deliveries TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: uber_delivery_webhook_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.uber_delivery_webhook_events ENABLE ROW LEVEL SECURITY;

--
-- Name: uber_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.uber_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: uber_integrations uber_integrations_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY uber_integrations_user_isolation ON public.uber_integrations TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: uber_pickup_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.uber_pickup_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: uber_pickup_locations uber_pickup_locations_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY uber_pickup_locations_user_isolation ON public.uber_pickup_locations TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: uber_delivery_webhook_events uber_webhook_events_read_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY uber_webhook_events_read_policy ON public.uber_delivery_webhook_events FOR SELECT TO authenticated USING (true);


--
-- Name: user_inbound_agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_inbound_agents ENABLE ROW LEVEL SECURITY;

--
-- Name: user_outbound_agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_outbound_agents ENABLE ROW LEVEL SECURITY;

--
-- Name: user_outbound_agents user_outbound_agents_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_outbound_agents_user_isolation ON public.user_outbound_agents TO authenticated USING (((user_id = auth.tenant_id()) OR (user_id = auth.uid()))) WITH CHECK (((user_id = auth.tenant_id()) OR (user_id = auth.uid())));


--
-- Name: user_push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_push_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: user_voice_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_voice_config ENABLE ROW LEVEL SECURITY;

--
-- Name: user_voice_config user_voice_config_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_voice_config_user_isolation ON public.user_voice_config TO authenticated USING (((user_id = auth.tenant_id()) OR (user_id = auth.uid()))) WITH CHECK (((user_id = auth.tenant_id()) OR (user_id = auth.uid())));


--
-- Name: user_voice_phone_numbers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_voice_phone_numbers ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: users users_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_isolation ON public.users TO authenticated USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));


--
-- Name: voice_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_profiles voice_profiles_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY voice_profiles_user_isolation ON public.voice_profiles TO authenticated USING (((user_id = auth.tenant_id()) OR (user_id IS NULL))) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: wallet_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_transactions wallet_transactions_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_transactions_tenant_isolation ON public.wallet_transactions TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: webhook_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_accounts whatsapp_accounts_user_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY whatsapp_accounts_user_isolation ON public.whatsapp_accounts TO authenticated USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: whatsapp_form_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_form_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_form_submissions whatsapp_form_submissions_user_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY whatsapp_form_submissions_user_all ON public.whatsapp_form_submissions USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: whatsapp_forms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_forms ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_forms whatsapp_forms_user_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY whatsapp_forms_user_all ON public.whatsapp_forms USING ((user_id = auth.tenant_id())) WITH CHECK ((user_id = auth.tenant_id()));


--
-- Name: whatsapp_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_messages whatsapp_messages_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY whatsapp_messages_tenant_isolation ON public.whatsapp_messages TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: whatsapp_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_templates whatsapp_templates_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY whatsapp_templates_tenant_isolation ON public.whatsapp_templates TO authenticated USING ((tenant_id = auth.tenant_id())) WITH CHECK ((tenant_id = auth.tenant_id()));


--
-- Name: workspace_invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_roles ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

