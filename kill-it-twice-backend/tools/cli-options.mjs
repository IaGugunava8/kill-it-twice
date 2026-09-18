export function readOptions(defaults) {
  const options = { ...defaults };

  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`expected --name value, received ${key ?? '<nothing>'}`);
    }

    const optionName = key.slice(2).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    if (!(optionName in options)) {
      throw new Error(`unknown option: ${key}`);
    }

    options[optionName] =
      typeof defaults[optionName] === 'number' ? Number(value) : value;
  }

  return options;
}

export function databaseUrl() {
  return (
    process.env.DATABASE_URL ??
    'postgresql://optio:optio-local@127.0.0.1:15432/optio'
  );
}
