import { HotPotatoRepository } from "@hot-potato/db";

const globalForRepository = globalThis as unknown as {
  hotPotatoRepository?: HotPotatoRepository;
};

export const repository =
  globalForRepository.hotPotatoRepository ?? new HotPotatoRepository();

if (process.env.NODE_ENV !== "production") {
  globalForRepository.hotPotatoRepository = repository;
}
