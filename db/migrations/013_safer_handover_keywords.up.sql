-- 013 Safer default handover keywords. The single word "person" matched normal
--     sales questions ("price per person?"), handing the chat to a human by mistake.
--     Only rows still on the old default are changed; admin-edited lists are kept.
ALTER TABLE ai_agent_config ALTER COLUMN handover_keywords SET DEFAULT
  '["human","agent","call me","talk to a person","speak to someone","real person","manager","customer care"]'::jsonb;

UPDATE ai_agent_config
   SET handover_keywords = '["human","agent","call me","talk to a person","speak to someone","real person","manager","customer care"]'::jsonb
 WHERE handover_keywords = '["human","agent","call me","person","manager"]'::jsonb;
