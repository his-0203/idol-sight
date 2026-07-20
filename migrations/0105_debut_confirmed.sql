-- migrations/0105_debut_confirmed.sql
--
-- V2.53 Organic Trust Layer — 정식 데뷔 확정 플래그.
-- 잠정 앵커(debut_date 는 있으나 정식 데뷔 미확정, mig 0093 BTHD)를 Health
-- Score PRE 게이트가 인식하게 한다. organicity/Debut Window/인지도 집계는
-- debut_date 를 그대로 사용(등급만 게이트).
-- 해제 절차: 정식 데뷔 확정 시
--   UPDATE groups SET debut_date='<확정일>', debut_confirmed=1 WHERE key='<key>';

ALTER TABLE groups ADD COLUMN debut_confirmed INTEGER NOT NULL DEFAULT 1;

-- BTHD: 2026-06-26 은 선공개 싱글 잠정 앵커(정식 데뷔 10월 초 예상, 미확정).
UPDATE groups SET debut_confirmed=0 WHERE key='bthd';
