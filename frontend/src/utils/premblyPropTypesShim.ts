const validator = () => undefined;

const propTypes = {
  string: validator,
  object: validator,
  func: validator,
  oneOfType: () => validator,
};

export default propTypes;
