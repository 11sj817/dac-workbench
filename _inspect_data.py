import zipfile, pandas as pd, io, os
d = r"PROJDIR\dac-reverse-research\data\public"
z = zipfile.ZipFile(os.path.join(d, "student.zip"))
print("zip:", z.namelist())
for name in z.namelist():
    if name.endswith(".csv"):
        raw = z.read(name)
        for enc in ("utf-8", "latin-1"):
            try:
                df = pd.read_csv(io.BytesIO(raw), sep=";", encoding=enc); break
            except Exception: continue
        print("==", name, df.shape)
        print(" cols:", list(df.columns)[:20])
        print(df.head(3).to_string()[:600])
for f in ["winequality-red.csv", "winequality-white.csv"]:
    p = os.path.join(d, f)
    df = pd.read_csv(p, sep=";")
    print("==", f, df.shape)
    print(" cols:", list(df.columns))
    print(df.describe().round(2).to_string()[:400])
