// Deliberately killed by the regression test while its SQLite WAL is open.
import { LocalStore } from "../electron/local-store";
import { taskBodySchema } from "../shared/contract";
const store = new LocalStore(
  process.argv[2],
  process.argv[3],
  Buffer.from(process.env.TASKLINK_TEST_KEY!, "base64"),
);
for (let i = 0; i < 1000; i++)
  store.save(
    "task",
    taskBodySchema.parse({ title: "Committed before crash " + i }),
    null,
  );
process.stdout.write("committed:1000\n");
setInterval(() => {}, 1000);
